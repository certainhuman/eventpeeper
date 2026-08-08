if (typeof EventPeeperV2 === 'undefined' && typeof importScripts === 'function') {
    importScripts('v2-model.js');
}

const VERSION = chrome.runtime.getManifest().version;
const API_BASE = 'https://dsa-api.certainhuman.com/v2';
const ENDPOINTS = {servers: `${API_BASE}/game/servers`, missions: `${API_BASE}/missions/active`, pvp: `${API_BASE}/pvp-events/schedule`};
const CACHE_KEY = 'event-peeper:v2:snapshot';
const storage = typeof browser !== 'undefined' ? browser.storage : chrome.storage;
let snapshot = null;
let endpointBodies = {servers: {}, missions: {}, pvp: {}};
let inFlight = null;

function requestHeaders() {
    return {'Cache-Control': 'no-cache', Pragma: 'no-cache', 'User-Agent': `EventPeeper/${VERSION}`, 'X-App-Version': VERSION};
}
async function loadCache() {
    if (snapshot) return snapshot;
    try {
        const stored = await storage.local.get(CACHE_KEY);
        endpointBodies = stored?.[CACHE_KEY]?.endpointBodies || endpointBodies;
        snapshot = stored?.[CACHE_KEY]?.snapshot || null;
    } catch (error) { console.error('Failed to load v2 snapshot:', error); }
    return snapshot;
}
async function saveCache() {
    try { await storage.local.set({[CACHE_KEY]: {endpointBodies, snapshot}}); }
    catch (error) { console.error('Failed to save v2 snapshot:', error); }
}
function notify() { try { chrome.runtime.sendMessage({type: 'event-peeper:update', payload: snapshot}); } catch {} }
async function fetchEndpoint(name) {
    const response = await fetch(ENDPOINTS[name], {cache: 'no-cache', headers: requestHeaders()});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}
async function refreshSnapshot({forced = false} = {}) {
    await loadCache();
    if (inFlight) return inFlight;
    if (!forced && snapshot && Date.now() - Number(snapshot.savedAt || 0) < 30_000) return snapshot;
    snapshot = {...(snapshot || {}), loading: true, errors: {}};
    notify();
    inFlight = (async () => {
        const results = await Promise.allSettled(Object.keys(ENDPOINTS).map(fetchEndpoint));
        const errors = {};
        Object.keys(ENDPOINTS).forEach((name, index) => {
            if (results[index].status === 'fulfilled') {
                endpointBodies[name] = results[index].value;
            } else {
                errors[name] = String(results[index].reason?.message || results[index].reason || 'Request failed');
            }
        });
        snapshot = EventPeeperV2.createSnapshot({
            serversBody: endpointBodies.servers, missionsBody: endpointBodies.missions, pvpBody: endpointBodies.pvp,
            generatedAt: {servers: endpointBodies.servers?.generated_at_unix, missions: endpointBodies.missions?.generated_at_unix, pvp: endpointBodies.pvp?.generated_at_unix},
            savedAt: Date.now(), errors, loading: false
        });
        await saveCache();
        notify();
        return snapshot;
    })().catch(error => {
        snapshot = {...(snapshot || {}), loading: false, errors: {request: String(error.message || error)}};
        notify();
        return snapshot;
    }).finally(() => { inFlight = null; });
    return inFlight;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'event-peeper:get-version') { sendResponse({version: VERSION, apiUrl: API_BASE}); return false; }
    if (message?.type === 'event-peeper:get-all') {
        loadCache().then(async () => {
            await saveCache();
            sendResponse(snapshot || {loading: true, errors: {}});
            await refreshSnapshot();
        });
        return true;
    }
    if (message?.type === 'event-peeper:refresh-all') { refreshSnapshot({forced: true}).then(sendResponse); return true; }
});
