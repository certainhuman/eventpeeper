const API_URL = 'https://event-api.certainhuman.com/event';

let cache = {
  data: null,
  error: null,
  loading: false,
  lastUpdated: 0,
};

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_REQUESTS = 10;
const requestTimes = []; // timestamps (ms)
let retryTimer = null; // scheduled retry timer id
/**
 * Removes request timestamps that are older than the rolling rate-limit window.
 * Keeps requestTimes containing only entries within RATE_WINDOW_MS.
 */
function pruneOld() {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  while (requestTimes.length && requestTimes[0] < cutoff) requestTimes.shift();
}
/**
 * Calculates the milliseconds until the next request slot becomes available
 * under the local rolling rate limit.
 * @returns {number} Milliseconds to wait before another auto request is allowed (0 if allowed now).
 */
function timeUntilNextSlotMs() {
  pruneOld();
  if (requestTimes.length < RATE_MAX_REQUESTS) return 0;
  const oldest = requestTimes[0];
  const wait = RATE_WINDOW_MS - (Date.now() - oldest);
  return Math.max(0, wait);
}
/**
 * Indicates whether an automatic (non-forced) request is permitted under the local rate limiter.
 * @returns {boolean} True if another auto request can be made now; otherwise false.
 */
function canMakeAutoRequest() {
  pruneOld();
  return requestTimes.length < RATE_MAX_REQUESTS;
}
/**
 * Records the current time as an issued request for local rate-limiting purposes.
 * Maintains the rolling window by pruning old timestamps first.
 */
function recordRequest() {
  pruneOld();
  requestTimes.push(Date.now());
}
/**
 * Schedules a single-shot local retry for an auto request once the rate-limit window allows it.
 * Also ensures only one retry timer is active at a time.
 */
function scheduleLocalRetry() {
  if (retryTimer) return; // already scheduled
  const delay = Math.max(200, timeUntilNextSlotMs());
  retryTimer = setTimeout(() => {
    retryTimer = null;
    fetchFromAPI({ forced: false });
  }, delay);
}

let inFlight = null;

/**
 * Fetches event data from the API with caching, error handling, and rate limiting.
 * - Respects local auto rate limit unless forced.
 * - Updates cache and notifies any open popups on state changes.
 * - Handles HTTP 429 and server-side rate-limit JSON, optionally scheduling retries.
 * @returns {Promise<{data:any,error:string|null,loading:boolean,lastUpdated:number}>|{data:any,error:string|null,loading:boolean,lastUpdated:number}}
 */
async function fetchFromAPI({ forced = false } = {}) {
  if (cache.loading && inFlight) return inFlight;

  const isStale = Date.now() - cache.lastUpdated > 30_000;
  if (!forced && !isStale) return { ...cache };

  if (!forced && !canMakeAutoRequest()) {
    const waitMs = timeUntilNextSlotMs();
    cache = { ...cache, loading: false, error: `Local auto rate limit reached (max ${RATE_MAX_REQUESTS}/${Math.round(RATE_WINDOW_MS/1000)}s). Retrying in ${Math.ceil(waitMs/1000)}s…` };
    notifyPopup();
    scheduleLocalRetry();
    return { ...cache };
  }

  cache = { ...cache, loading: true, error: null };
  notifyPopup();

  recordRequest();

  inFlight = (async () => {
    try {
      const res = await fetch(API_URL, { cache: 'no-cache' });

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
        cache = { ...cache, loading: false, error: msg };
        notifyPopup();
        if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; fetchFromAPI({ forced: false }); }, retryDelayMs);
        return cache;
      }

      if (!res.ok) { // noinspection ExceptionCaughtLocallyJS cmon why not
          throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();

      cache = { data, error: null, loading: false, lastUpdated: Date.now() };
      return cache;
    } catch (e) {
      cache = { ...cache, loading: false, error: `Failed to fetch events. ${e?.message ?? e}` };
      return cache;
    } finally {
      notifyPopup();
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Notifies any open popup about cache changes by sending a runtime message.
 * Safe to call when no listeners are present.
 */
function notifyPopup() {
  try {
    chrome.runtime.sendMessage({ type: 'event-peeper:update', payload: { ...cache } });
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
  const { type, forced } = message || {};
  if (type === 'event-peeper:get') {
    const snapshot = { ...cache };
    sendResponse(snapshot);
    fetchFromAPI({ forced: false });
    return true;
  }
  if (type === 'event-peeper:refresh') {
    fetchFromAPI({ forced: !!forced }).then((updated) => {
      sendResponse(updated);
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
    fetchFromAPI({ forced: false });
  }
});
