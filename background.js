const API_URL = 'https://event-api.certainhuman.com/event';

// Valid server ids currently: 0 (US EAST OLD), 1 (US EAST NEW)
let caches = {
  0: { data: null, error: null, loading: false, lastUpdated: 0 },
  1: { data: null, error: null, loading: false, lastUpdated: 0 },
};

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_REQUESTS = 10;
const requestTimes = {
  0: [],
  1: [],
};
let retryTimer = { 0: null, 1: null };
/**
 * Removes request timestamps that are older than the rolling rate-limit window for a server.
 */
function pruneOld(server) {
  const arr = requestTimes[server] || (requestTimes[server] = []);
  const cutoff = Date.now() - RATE_WINDOW_MS;
  while (arr.length && arr[0] < cutoff) arr.shift();
}
/**
 * Calculates the milliseconds until the next request slot becomes available for a server.
 * @returns {number} Milliseconds to wait before another auto request is allowed (0 if allowed now).
 */
function timeUntilNextSlotMs(server) {
  pruneOld(server);
  const arr = requestTimes[server] || [];
  if (arr.length < RATE_MAX_REQUESTS) return 0;
  const oldest = arr[0];
  const wait = RATE_WINDOW_MS - (Date.now() - oldest);
  return Math.max(0, wait);
}
/**
 * Indicates whether an automatic (non-forced) request is permitted for a server.
 * @returns {boolean} True if another auto request can be made now; otherwise false.
 */
function canMakeAutoRequest(server) {
  pruneOld(server);
  const arr = requestTimes[server] || [];
  return arr.length < RATE_MAX_REQUESTS;
}
/**
 * Records the current time as an issued request for local rate-limiting purposes for a server.
 */
function recordRequest(server) {
  pruneOld(server);
  (requestTimes[server] || (requestTimes[server] = [])).push(Date.now());
}
/**
 * Schedules a single-shot local retry for an auto request once the rate-limit window allows it, per server.
 */
function scheduleLocalRetry(server) {
  if (retryTimer[server]) return; // already scheduled
  const delay = Math.max(200, timeUntilNextSlotMs(server));
  retryTimer[server] = setTimeout(() => {
    retryTimer[server] = null;
    fetchFromAPI({ forced: false, server });
  }, delay);
}

let inFlight = { 0: null, 1: null };

/**
 * Fetches event data from the API with caching, error handling, and rate limiting.
 * - Respects local auto rate limit unless forced.
 * - Updates cache and notifies any open popups on state changes.
 * - Handles HTTP 429 and server-side rate-limit JSON, optionally scheduling retries.
 * @returns {Promise<{data:any,error:string|null,loading:boolean,lastUpdated:number}>|{data:any,error:string|null,loading:boolean,lastUpdated:number}}
 */
async function fetchFromAPI({ forced = false, server = 1 } = {}) {
  let cache = caches[server] || (caches[server] = { data: null, error: null, loading: false, lastUpdated: 0 });
  if (cache.loading && inFlight && inFlight[server]) return inFlight[server];

  const isStale = Date.now() - cache.lastUpdated > 30_000;
  if (!forced && !isStale) return { ...cache };

  if (!forced && !canMakeAutoRequest(server)) {
    const waitMs = timeUntilNextSlotMs(server);
    caches[server] = { ...cache, loading: false, error: `Local auto rate limit reached (max ${RATE_MAX_REQUESTS}/${Math.round(RATE_WINDOW_MS/1000)}s). Retrying in ${Math.ceil(waitMs/1000)}s…` };
    notifyPopup(server);
    scheduleLocalRetry(server);
    return { ...caches[server] };
  }

  caches[server] = { ...cache, loading: true, error: null };
  notifyPopup(server);

  recordRequest(server);

  inFlight[server] = (async () => {
    try {
      const res = await fetch(`${API_URL}?server=${encodeURIComponent(server)}`, { cache: 'no-cache' });

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
        let msg = 'API rate limit exceeded (HTTP 429). Retrying soon…';
        try {
          const body = await res.json();
          if (body && (body.error || body.message)) {
            msg = 'API rate limit exceeded (server-side). Retrying soon…';
          }
        } catch {}
        caches[server] = { ...cache, loading: false, error: msg };
        notifyPopup(server);
        if (!retryTimer[server]) retryTimer[server] = setTimeout(() => { retryTimer[server] = null; fetchFromAPI({ forced: false, server }); }, retryDelayMs);
        return caches[server];
      }

      if (!res.ok) { // noinspection ExceptionCaughtLocallyJS cmon why not
          throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();

      caches[server] = { data, error: null, loading: false, lastUpdated: Date.now() };
      return caches[server];
    } catch (e) {
      caches[server] = { ...cache, loading: false, error: `Failed to fetch events. ${e?.message ?? e}` };
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
    const payload = { ...(caches[server] || {}), server };
    chrome.runtime.sendMessage({ type: 'event-peeper:update', payload });
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
  const { type, forced, server } = message || {};
  const serverId = Number.isInteger(server) ? server : 1;
  if (type === 'event-peeper:get') {
    const snapshot = { ...(caches[serverId] || {}), server: serverId };
    sendResponse(snapshot);
    fetchFromAPI({ forced: false, server: serverId });
    return true;
  }
  if (type === 'event-peeper:get-all') {
    const resp = {
      0: { ...(caches[0] || {}), server: 0 },
      1: { ...(caches[1] || {}), server: 1 },
    };
    sendResponse(resp);
    fetchFromAPI({ forced: false, server: 0 });
    fetchFromAPI({ forced: false, server: 1 });
    return true;
  }
  if (type === 'event-peeper:refresh') {
    fetchFromAPI({ forced: !!forced, server: serverId }).then((updated) => {
      sendResponse(updated);
    });
    return true;
  }
  if (type === 'event-peeper:refresh-all') {
    Promise.all([
      fetchFromAPI({ forced: true, server: 0 }),
      fetchFromAPI({ forced: true, server: 1 }),
    ]).then(([s0, s1]) => {
      sendResponse({ 0: s0, 1: s1 });
    });
    return true;
  }
});

// Make sure the popup is updated at least once per minute, even if the user doesn't open the popup. Sometimes this doesn't happen. Why? Good question.
/**
 * Installed/updated lifecycle handler: sets up a periodic alarm to refresh data in the background.
 */
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.alarms) chrome.alarms.create('event-peeper:tick', { periodInMinutes: 1 });
});
/**
 * Alarm handler: triggers periodic non-forced refreshes when the scheduled alarm fires.
 * Ensures data stays reasonably fresh even without the popup being opened.
 */
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'event-peeper:tick') {
    // refresh both known servers to keep caches warm
    fetchFromAPI({ forced: false, server: 0 });
    fetchFromAPI({ forced: false, server: 1 });
  }
});
