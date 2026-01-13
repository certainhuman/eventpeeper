const API_URL = 'https://event-api.certainhuman.com/event';
const SERVERS_URL = 'https://event-api.certainhuman.com/servers';

let caches = {};

let serversList = null; // {server_id, name, option_id, active}
let serversPromise = null;

async function fetchServersOnce() {
    if (Array.isArray(serversList)) return serversList;
    if (serversPromise) return serversPromise;
    serversPromise = (async () => {
        try {
            const res = await fetch(SERVERS_URL, {cache: 'no-cache'});
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

// Global rate limiting (across all servers)
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

/**
 * Fetches event data from the API with caching, error handling, and rate limiting.
 * @returns {Promise<{data:any,error:string|null,loading:boolean,lastUpdated:number}>|{data:any,error:string|null,loading:boolean,lastUpdated:number}}
 */
async function fetchFromAPI({forced = false, server = 1} = {}) {
    let cache = caches[server] || (caches[server] = {data: null, error: null, loading: false, lastUpdated: 0});
    if (cache.loading && inFlight && inFlight[server]) return inFlight[server];

    const isStale = Date.now() - cache.lastUpdated > 30_000;
    if (!forced && !isStale) return {...cache};

    if (!forced && !canMakeAutoRequest()) {
        notifyPopup(server);
        scheduleLocalRetry(server);
        return {...cache};
    }

    caches[server] = {...cache, loading: true, error: null};
    notifyPopup(server);

    recordRequest();

    inFlight[server] = (async () => {
        try {
            const res = await fetch(`${API_URL}?server=${encodeURIComponent(server)}`, {
                cache: 'no-cache',
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
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
                // Preserve existing data, just clear loading state
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
            return caches[server];
        } catch (e) {
            // On error, preserve existing data and just clear loading state
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
        const snapshot = {...(caches[id] || {}), server: id};
        sendResponse(snapshot);
        if (typeof id === 'number') fetchFromAPI({forced: false, server: id});
        return true;
    }

    if (type === 'event-peeper:get-all') {
        fetchServersOnce().then((list) => {
            const ids = list.map(s => s.server_id);
            const resp = {};
            ids.forEach(id => {
                resp[id] = {...(caches[id] || {}), server: id, name: getServerName(id)};
            });
            sendResponse(resp);
            ids.forEach(id => fetchFromAPI({forced: false, server: id}));
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

chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === 'event-peeper:tick') {
        fetchServersOnce().then((list) => {
            const ids = list.map(s => s.server_id);
            ids.forEach(id => fetchFromAPI({forced: false, server: id}));
        });
    }
});