const VERSION = chrome.runtime.getManifest().version;
const API_URL = 'https://dsa-api.certainhuman.com/v1/missions/current';
const SERVERS_URL = 'https://dsa-api.certainhuman.com/v1/game/servers';

// Timing constants (in seconds)
const ANNOUNCE_WINDOW_SEC = 3 * 60; // 3 minutes from announce to open
const OPEN_WINDOW_SEC = 15 * 60; // 15 minutes open duration
const COOLDOWN_GAP_SEC = 27 * 60; // 27 minutes from close to next announce

let caches = {};

let serversList = null; // {server_id, name, option_id, active}
let serversPromise = null;

async function fetchServersOnce() {
    if (Array.isArray(serversList)) return serversList;
    if (serversPromise) return serversPromise;
    serversPromise = (async () => {
        try {
            const res = await fetch(SERVERS_URL, {
                cache: 'no-cache', headers: {
                    'User-Agent': `EventPeeper/${VERSION}`, 'X-App-Version': VERSION
                }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            const list = Array.isArray(body?.servers) ? body.servers : [];
            serversList = list.filter(s => (typeof s?.active === 'number' ? s.active === 1 : true));
            return serversList;
        } catch (e) {
            serversList = [];
            return serversList;
        } finally {
            serversPromise = null;
        }
    })();
    return serversPromise;
}

function getServerIdsSync() {
    return Array.isArray(serversList) ? serversList.map(s => s.server_id) : [];
}

function getServerName(serverId) {
    if (!Array.isArray(serversList)) return String(serverId);
    const s = serversList.find(x => x.server_id === serverId);
    return s?.name ?? String(serverId);
}

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_REQUESTS = 10;
const globalRequestTimes = [];
let retryTimer = {};

/**
 * Removes request timestamps that are older than the rolling rate-limit window.
 */
function pruneOld() {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (globalRequestTimes.length && globalRequestTimes[0] < cutoff) {
        globalRequestTimes.shift();
    }
}

/**
 * Calculates the milliseconds until the next request slot becomes available globally.
 * @returns {number} Milliseconds to wait before another auto request is allowed (0 if allowed now).
 */
function timeUntilNextSlotMs() {
    pruneOld();
    if (globalRequestTimes.length < RATE_MAX_REQUESTS) return 0;
    const oldest = globalRequestTimes[0];
    const wait = RATE_WINDOW_MS - (Date.now() - oldest);
    return Math.max(0, wait);
}

/**
 * Indicates whether an automatic (non-forced) request is permitted globally.
 * @returns {boolean} True if another auto request can be made now; otherwise false.
 */
function canMakeAutoRequest() {
    pruneOld();
    return globalRequestTimes.length < RATE_MAX_REQUESTS;
}

/**
 * Records the current time as an issued request for local rate-limiting purposes.
 */
function recordRequest() {
    pruneOld();
    globalRequestTimes.push(Date.now());
}

/**
 * Returns current rate limit status.
 */
function getRateLimitStatus() {
    pruneOld();
    return {
        used: globalRequestTimes.length,
        max: RATE_MAX_REQUESTS,
        available: RATE_MAX_REQUESTS - globalRequestTimes.length,
        nextSlotMs: timeUntilNextSlotMs()
    };
}

/**
 * Schedules a single-shot local retry for an auto request once the rate-limit window allows it.
 */
function scheduleLocalRetry(server) {
    if (retryTimer[server]) return; // already scheduled
    const delay = Math.max(200, timeUntilNextSlotMs());
    retryTimer[server] = setTimeout(() => {
        retryTimer[server] = null;
        fetchFromAPI({forced: false, server});
    }, delay);
}

let inFlight = {};

// route to either chrome.storage or browser.storage
const storage = typeof browser !== 'undefined' ? browser.storage : chrome.storage;

/**
 * Save state to local storage
 */
async function saveState(server, data) {
    const key = `event-peeper:state:${server}`;
    try {
        const toSave = {
            data: data, // This is {data: {...}, error, loading, lastUpdated}
            savedAt: Date.now()
        };
        await storage.local.set({[key]: toSave});
    } catch (e) {
        console.error(`[Server ${server}] Failed to save state:`, e);
    }
}

/**
 * Load state from local storage
 */
async function loadState(server) {
    const key = `event-peeper:state:${server}`;
    try {
        const result = await storage.local.get(key);
        if (result && typeof result === 'object' && key in result) {
            return result[key];
        }
        return null;
    } catch (e) {
        console.error('Failed to load state:', e);
        return null;
    }
}

/**
 * Predict the current state based on saved data and time elapsed
 */
function predictState(savedState) {
    if (!savedState?.data?.data) return null;

    const now = Math.floor(Date.now() / 1000);
    let currentData = savedState.data.data;
    let iterations = 0;
    const maxIterations = 4; // this is a safeguard, a query should be required in 3 iterations

    while (iterations < maxIterations) {
        iterations++;
        const nextState = predictNextState(currentData, now);

        if (!nextState || nextState.type === currentData.type) {
            break; // state no longer changing
        }

        currentData = nextState;
    }

    if (iterations >= maxIterations) {
        return null; //forces query
    }

    return currentData;
}

/**
 * Predict the next state transition
 */
function predictNextState(data, now) {
    if (!data) return null;

    if (data.type === 'announced') {
        const openTime = data.event?.open_time;
        if (openTime && now >= openTime) {
            // announced -> open
            return {
                type: 'open',
                event: {
                    name: data.event?.name,
                    open_time: openTime,
                    close_time: openTime + OPEN_WINDOW_SEC
                }
            };
        }
    } else if (data.type === 'open') {
        const closeTime = data.event?.close_time || (data.event?.open_time + OPEN_WINDOW_SEC);
        if (closeTime && now >= closeTime) {
            // open -> closed
            return {
                type: 'closed',
                predicted_open_time: closeTime + COOLDOWN_GAP_SEC + ANNOUNCE_WINDOW_SEC
            };
        }
    } else if (data.type === 'closed') {
        const announceTime = data.predicted_open_time ? data.predicted_open_time - ANNOUNCE_WINDOW_SEC : null;
        if (announceTime && now >= announceTime) {
            // closed -> query API for new event
            return null;
        }
    }

    return null; // No state change
}

/**
 * Check if we need to query the API based on predicted state
 */
function needsApiQuery(predictedData, now) {
    if (!predictedData) return true;

    if (predictedData.type === 'closed') {
        const announceTime = predictedData.predicted_open_time ? predictedData.predicted_open_time - ANNOUNCE_WINDOW_SEC : null;
        // Need to query if we're past the announcement time
        return announceTime && now >= announceTime;
    }

    return false;
}

/**
 * Fetches event data from the API with caching, error handling, and rate limiting.
 * Now uses local storage and state prediction to minimize API calls.
 * @returns {Promise<{data:any,error:string|null,loading:boolean,lastUpdated:number}>|{data:any,error:string|null,loading:boolean,lastUpdated:number}}
 */
async function fetchFromAPI({forced = false, server = 1} = {}) {
    let cache = caches[server] || (caches[server] = {data: null, error: null, loading: false, lastUpdated: 0});

    if (cache.loading && inFlight && inFlight[server]) return inFlight[server];

    if (!forced) {
        const savedState = await loadState(server);

        if (savedState?.data?.data) {
            const now = Math.floor(Date.now() / 1000);
            const predictedData = predictState(savedState);

            if (predictedData && !needsApiQuery(predictedData, now)) {
                cache = {
                    data: predictedData,
                    error: null,
                    loading: false,
                    lastUpdated: savedState.savedAt || Date.now()
                };
                caches[server] = cache;
                notifyPopup(server);
                return {...cache};
            }
        } else {
            console.log(`[Server ${server}] No saved state found`);
        }

        // Check rate limiting before making the API call
        if (!canMakeAutoRequest()) {
            console.log(`[Server ${server}] Rate limited, scheduling retry`);
            notifyPopup(server);
            scheduleLocalRetry(server);
            return {...cache};
        }
    }

    console.log(`[Server ${server}] Making API call (forced: ${forced})`);
    caches[server] = {...cache, loading: true, error: null};
    notifyPopup(server);

    recordRequest();

    inFlight[server] = (async () => {
        try {
            const res = await fetch(`${API_URL}?server=${encodeURIComponent(server)}`, {
                cache: 'no-cache', headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'User-Agent': `EventPeeper/${VERSION}`,
                    'X-App-Version': VERSION
                }
            });

            if (res.status === 429) {
                let retryDelayMs = 10_000;
                const ra = res.headers.get('Retry-After');
                if (ra) {
                    const secs = Number(ra);
                    if (!Number.isNaN(secs)) {
                        retryDelayMs = Math.max(1000, secs * 1000);
                    } else {
                        const date = new Date(ra);
                        const ms = date.getTime() - Date.now();
                        if (!Number.isNaN(ms)) retryDelayMs = Math.max(1000, ms);
                    }
                }
                caches[server] = {...cache, loading: false};
                notifyPopup(server);
                if (!retryTimer[server]) retryTimer[server] = setTimeout(() => {
                    retryTimer[server] = null;
                    fetchFromAPI({forced: false, server});
                }, retryDelayMs);
                return caches[server];
            }

            if (!res.ok) { // noinspection ExceptionCaughtLocallyJS cmon why not
                throw new Error(`HTTP ${res.status}`);
            }

            const data = await res.json();

            caches[server] = {data, error: null, loading: false, lastUpdated: Date.now()};

            await saveState(server, {data, error: null, loading: false, lastUpdated: Date.now()});

            return caches[server];
        } catch (e) {
            console.error(`[Server ${server}] API error:`, e);
            caches[server] = {...cache, loading: false};
            return caches[server];
        } finally {
            notifyPopup(server);
            inFlight[server] = null;
        }
    })();

    return inFlight[server];
}

/**
 * Notifies any open popup about cache changes by sending a runtime message.
 * Safe to call when no listeners are present.
 */
function notifyPopup(server) {
    try {
        const payload = {...(caches[server] || {}), server};
        chrome.runtime.sendMessage({type: 'event-peeper:update', payload});
    } catch {
        // Well, we tried.
    }
}

/**
 * Message handler for popup-background communication.
 * - "event-peeper:get": returns a cache snapshot immediately and may trigger a non-forced fetch.
 * - "event-peeper:refresh": performs a forced fetch and responds with the updated cache when done.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const {type, forced, server} = message || {};
    const serverId = Number.isInteger(server) ? server : null;

    if (type === 'event-peeper:get-version') {
        sendResponse({version: VERSION, apiUrl: API_URL.split('/v1/')[0]});
        return true;
    }

    if (type === 'event-peeper:get-servers') {
        fetchServersOnce().then((list) => {
            sendResponse({servers: list});
        });
        return true;
    }

    if (type === 'event-peeper:get-rate-limit') {
        sendResponse(getRateLimitStatus());
        return true;
    }

    if (type === 'event-peeper:get') {
        const id = serverId ?? getServerIdsSync()[0];

        loadState(id).then(savedState => {
            if (savedState?.data?.data) {
                const now = Math.floor(Date.now() / 1000);
                const predictedData = predictState(savedState);

                if (predictedData && !needsApiQuery(predictedData, now)) {
                    const snapshot = {
                        data: predictedData,
                        error: null,
                        loading: false,
                        lastUpdated: savedState.savedAt || Date.now(),
                        server: id
                    };
                    caches[id] = snapshot;
                    sendResponse(snapshot);
                    return;
                }
            }

            // Otherwise fall back to cache or fetch
            const snapshot = {...(caches[id] || {}), server: id};
            sendResponse(snapshot);
            if (typeof id === 'number') fetchFromAPI({forced: false, server: id});
        });
        return true;
    }

    if (type === 'event-peeper:get-all') {
        fetchServersOnce().then(async (list) => {
            const ids = list.map(s => s.server_id);
            const resp = {};

            // Load all states from storage first
            const now = Math.floor(Date.now() / 1000);
            for (const id of ids) {
                const savedState = await loadState(id);

                if (savedState?.data?.data) {
                    const predictedData = predictState(savedState);

                    if (predictedData && !needsApiQuery(predictedData, now)) {
                        // Use predicted state
                        const snapshot = {
                            data: predictedData,
                            error: null,
                            loading: false,
                            lastUpdated: savedState.savedAt || Date.now(),
                            server: id,
                            name: getServerName(id)
                        };
                        caches[id] = snapshot;
                        resp[id] = snapshot;
                        continue;
                    }
                }

                // Use cache or mark for fetching
                resp[id] = {...(caches[id] || {}), server: id, name: getServerName(id)};
            }

            sendResponse(resp);

            // Only fetch for servers that need it
            for (const id of ids) {
                const savedState = await loadState(id);
                const now = Math.floor(Date.now() / 1000);

                if (!savedState?.data?.data) {
                    // No saved state, need to fetch
                    fetchFromAPI({forced: false, server: id});
                } else {
                    const predictedData = predictState(savedState);
                    if (needsApiQuery(predictedData, now)) {
                        // State requires fresh data
                        fetchFromAPI({forced: false, server: id});
                    }
                }
            }
        });
        return true;
    }

    if (type === 'event-peeper:refresh') {
        const id = serverId ?? getServerIdsSync()[0];
        fetchFromAPI({forced: !!forced, server: id}).then((updated) => {
            sendResponse(updated);
        });
        return true;
    }

    if (type === 'event-peeper:refresh-all') {
        fetchServersOnce().then((list) => {
            const ids = list.map(s => s.server_id);
            Promise.all(ids.map(id => fetchFromAPI({forced: true, server: id}))).then((results) => {
                const resp = {};
                ids.forEach((id, i) => {
                    resp[id] = results[i];
                });
                sendResponse(resp);
            });
        });
        return true;
    }
});