function updateHeaderInfo() {
    if (elems.rateLimitText && elems.rateLimitFill && elems.rateLimitBar) {
        const used = rateLimitInfo.used || 0;
        const max = rateLimitInfo.max || 10;
        const available = rateLimitInfo.available || 0;
        const percentage = (used / max) * 100;
        elems.rateLimitText.textContent = `${used}/${max}`;
        elems.rateLimitFill.style.width = `${percentage}%`;

        if (percentage < 50) {
            elems.rateLimitBar.setAttribute('data-level', 'low');
        } else if (percentage < 80) {
            elems.rateLimitBar.setAttribute('data-level', 'medium');
        } else {
            elems.rateLimitBar.setAttribute('data-level', 'high');
        }

        if (elems.refreshBtn) {
            if (available <= 0) {
                elems.refreshBtn.disabled = true;
                elems.refreshBtn.title = 'Rate limit exceeded. Wait a moment...';
            } else {
                elems.refreshBtn.disabled = false;
                elems.refreshBtn.title = 'Refresh now';
            }
        }
    }

    if (elems.lastUpdate) {
        if (lastGlobalUpdate > 0) {
            const secondsAgo = Math.floor((Date.now() - lastGlobalUpdate) / 1000);
            if (secondsAgo < 60) {
                elems.lastUpdate.textContent = `${secondsAgo}s ago`;
            } else {
                const minutesAgo = Math.floor(secondsAgo / 60);
                elems.lastUpdate.textContent = `${minutesAgo}m ago`;
            }
        } else {
            elems.lastUpdate.textContent = '—';
        }
    }

    if (elems.activeEvents) {
        let openCount = 0;
        let announcedCount = 0;
        serverIds.forEach(id => {
            const state = snapshotState(last[id]);
            if (state === 'open') openCount++;
            else if (state === 'announced') announcedCount++;
        });

        if (openCount > 0 && announcedCount > 0) {
            elems.activeEvents.textContent = `${openCount} open, ${announcedCount} announced`;
        } else if (openCount > 0) {
            elems.activeEvents.textContent = `${openCount} open`;
        } else if (announcedCount > 0) {
            elems.activeEvents.textContent = `${announcedCount} announced`;
        } else {
            elems.activeEvents.textContent = 'No events';
        }
    }
}// noinspection JSUnresolvedReference,GrazieInspection

const elems = {
    content: document.getElementById('content'),
    error: document.getElementById('error'),
    refreshBtn: document.getElementById('refreshBtn'),
    rows: document.getElementById('rows'),
    rateLimitText: document.getElementById('rateLimitText'),
    rateLimitFill: document.getElementById('rateLimitFill'),
    rateLimitBar: document.getElementById('rateLimitBar'),
    lastUpdate: document.getElementById('lastUpdate'),
    activeEvents: document.getElementById('activeEvents'),
};

let countdownTimers = {};
let nameEls = {};
let countdownEls = {};
let ringEls = {};
let ringCirc = {};
let statusEls = {};

// Event status timings and ring logic
// - Closed: 27 minutes until the next announcement (cooldown).
// - Announced: 3 minutes until the event opens.
// - Open: 15 minutes until the event closes.
// The countdown ring is a countdown: it starts full and shrinks to empty by the target moment.
const COOLDOWN_GAP_SEC = 27 * 60; // 27 minutes between close and the next announcement
const OPEN_WINDOW_SEC = 15 * 60; // 15 minutes open duration
const ANNOUNCE_WINDOW_SEC = 3 * 60; // 3 minutes pre-open announcement
let lastCloseTime = {}; // per-server last known close_time used to synthesize announcement/open when needed


/**
 * Formats a countdown between now and a target UNIX timestamp (seconds) as MM:SS.
 * Shows a leading '-' when the target is in the past.
 * Assumes maximum relevant duration is under one hour.
 * @param {number} targetTsSec - Target UNIX timestamp in seconds.
 * @returns {string} Countdown string in the form MM:SS or -MM:SS.
 */
function formatCooldown(targetTsSec) {
    const now = Math.floor(Date.now() / 1000);
    const diff = Math.abs(targetTsSec - now);
    const sign = targetTsSec >= now ? '' : '-';
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return `${sign}${mm}:${ss}`;
}

/**
 * Toggles the loading state styling for the popup content area.
 * @param {boolean} isLoading - True to apply loading styles; false to remove them.
 */
function setLoading(isLoading) {
    const header = document.querySelector('header');
    const icon = document.querySelector('#refreshBtn .icon');
    if (!isLoading && header?.classList.contains('loading') && icon) {
        elems.content.classList.remove('loading');
        const computed = getComputedStyle(icon);
        const durMs = 600;
        let elapsedMs = 0;
        try {
            const m = computed.transform.match(/matrix\(([^)]+)\)/);
            if (m) {
                const parts = m[1].split(',').map(x => parseFloat(x.trim()));
                const a = parts[0], b = parts[1];
                const angle = Math.atan2(b, a);
                const frac = (angle < 0 ? (angle + 2 * Math.PI) : angle) / (2 * Math.PI);
                elapsedMs = frac * durMs;
            }
        } catch {
        }
        const remaining = Math.max(150, durMs - (elapsedMs % durMs));
        header.classList.remove('loading');
        header.classList.add('loading-done');
        header.classList.add('loaded');
        clearTimeout(setLoading._finishTimer);
        setLoading._finishTimer = setTimeout(() => {
            header.classList.remove('loading-done');
            clearTimeout(setLoading._checkTimer);
            setLoading._checkTimer = setTimeout(() => {
                header.classList.remove('loaded');
            }, 1000);
        }, remaining);
        return;
    }
    // Normal toggle
    elems.content.classList.toggle('loading', isLoading);
    if (header) {
        header.classList.toggle('loading', isLoading);
        if (isLoading) {
            clearTimeout(setLoading._finishTimer);
            clearTimeout(setLoading._checkTimer);
            header.classList.remove('loading-done');
            header.classList.remove('loaded');
        }
    }
}

/**
 * Displays an error message in the popup.
 * @param {string} message - Text to show to the user.
 */
function showError(message) {
    elems.error.style.display = 'block';
    elems.error.textContent = message;
}

/**
 * Hides and clears any visible error message in the popup.
 */
function clearError() {
    elems.error.style.display = 'none';
    elems.error.textContent = '';
}

/**
 * Manage per-server countdown intervals for live ring/text updates.
 */
function clearTimer(server) {
    if (countdownTimers[server]) {
        clearInterval(countdownTimers[server]);
        countdownTimers[server] = null;
    }
}

function startTimer(server, targetTsSec, renderFn) {
    clearTimer(server);
    if (!targetTsSec) return;
    const tick = async () => {
        try {
            renderFn();
            maybeAutoRefreshOnZero(server);
        } catch (e) {
            // ignore timer errors to keep UI alive (not that we expect them)
        }
    };
    countdownTimers[server] = setInterval(tick, 1000);
}

/**
 * Checks server countdown and triggers a one-shot auto refresh when it crosses zero.
 */
async function maybeAutoRefreshOnZero(server) {
    const snap = last[server];
    const tgt = targetTs(server, snap);
    if (typeof tgt !== 'number') return;
    const now = Math.floor(Date.now() / 1000);
    const remaining = tgt - now;
    // Trigger a refresh when we cross zero, but only once per crossing
    if (remaining <= 0 && !maybeAutoRefreshOnZero._refreshed?.[server]) {
        maybeAutoRefreshOnZero._refreshed = maybeAutoRefreshOnZero._refreshed || {};
        maybeAutoRefreshOnZero._refreshed[server] = true;

        const currentState = snap?.data?.type;

        // Only show "checking" state when transitioning from closed to announced
        // For other transitions, optimistically update the UI immediately
        if (currentState === 'closed') {
            // Show checking state in UI
            last[server] = {...snap, checking: true};
            renderAll();
        } else if (currentState === 'announced') {
            // Optimistically assume event opened
            const openTime = effectiveOpenTime(server, snap);
            if (openTime) {
                last[server] = {
                    ...snap,
                    data: {
                        type: 'open',
                        event: {
                            name: snap.data?.event?.name,
                            open_time: openTime,
                            close_time: openTime + OPEN_WINDOW_SEC
                        }
                    }
                };
                renderAll();
            }
        } else if (currentState === 'open') {
            // Optimistically assume event closed
            const closeTime = snap.data?.event?.close_time || (snap.data?.event?.open_time + OPEN_WINDOW_SEC);
            if (closeTime) {
                last[server] = {
                    ...snap,
                    data: {
                        type: 'closed',
                        predicted_open_time: closeTime + COOLDOWN_GAP_SEC
                    }
                };
                lastCloseTime[server] = closeTime;
                renderAll();
            }
        }

        // Now fetch actual data in the background
        const resp = await requestRefreshAll();
        if (resp && typeof resp === 'object') {
            Object.keys(resp).forEach((k) => {
                const id = Number(k);
                if (!Number.isNaN(id)) {
                    const updated = resp[id];
                    if (updated && !updated.checking) {
                        last[id] = updated;
                    }
                }
            });
        }
        renderAll();
        // After refresh, allow future auto-refreshes when a new positive countdown appears
        setTimeout(() => {
            maybeAutoRefreshOnZero._refreshed[server] = false;
        }, 2000);
    } else if (remaining > 1) {
        // If countdown is back in positive territory, clear the one-shot flag
        maybeAutoRefreshOnZero._refreshed = maybeAutoRefreshOnZero._refreshed || {};
        maybeAutoRefreshOnZero._refreshed[server] = false;
    }
}


/**
 * Local store of last snapshots per server
 */
let last = {};
let rateLimitInfo = {used: 0, max: 10};
let lastGlobalUpdate = 0;

function effectiveOpenTime(server, snapshot) {
    const openTs = Number(snapshot?.data?.event?.open_time);
    const lc = Number(lastCloseTime[server]);
    if (Number.isFinite(openTs) && Number.isFinite(lc)) {
        return Math.max(openTs, lc + COOLDOWN_GAP_SEC);
    }
    return Number.isFinite(openTs) ? openTs : (Number.isFinite(lc) ? lc + COOLDOWN_GAP_SEC : null);
}

function targetTs(server, snapshot) {
    const data = snapshot?.data;
    if (!data) return null;
    if (data.type === 'open') {
        const open = Number(data.event?.open_time);
        if (Number.isFinite(open)) return open + OPEN_WINDOW_SEC;
        return data.event?.close_time || null;
    }
    if (data.type === 'announced') return effectiveOpenTime(server, snapshot);
    if (data.type === 'closed') {
        if (typeof data.predicted_open_time === 'number') return data.predicted_open_time - ANNOUNCE_WINDOW_SEC; // countdown to announcement
        const lc = Number(lastCloseTime[server]);
        return Number.isFinite(lc) ? lc + COOLDOWN_GAP_SEC : null;
    }
    return null;
}

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

/**
 * Computes progress [0..1] and remaining seconds toward the relevant target, depending on state.
 * - open: progress from open_time to close_time
 * - announced: progress from first-seen remaining to 0
 * - closed: progress from first-seen remaining to 0 (using predicted_open_time if available)
 */
function computeProgress(server, snapshot) {
    const data = snapshot?.data;
    if (!data) return {progress: 0, remaining: null};
    const now = Math.floor(Date.now() / 1000);
    if (data.type === 'open') {
        const open = Number(data.event?.open_time);
        if (Number.isFinite(open)) {
            const close = open + OPEN_WINDOW_SEC;
            const remaining = Math.max(0, close - now);
            const progress = clamp01(1 - (remaining / OPEN_WINDOW_SEC));
            return {progress, remaining};
        }
        // Fallback: if API gave a concrete close_time, still treat as 15m total from now for visual consistency
        const t = Number(data.event?.close_time);
        if (Number.isFinite(t)) {
            const remaining = Math.max(0, t - now);
            const progress = clamp01(1 - (remaining / OPEN_WINDOW_SEC));
            return {progress, remaining};
        }
        return {progress: 0, remaining: null};
    }
    if (data.type === 'announced') {
        const effOpen = effectiveOpenTime(server, snapshot);
        if (Number.isFinite(effOpen)) {
            const remaining = Math.max(0, effOpen - now);
            // 3-minute announce window
            const progress = clamp01(1 - (remaining / ANNOUNCE_WINDOW_SEC));
            return {progress, remaining};
        }
        return {progress: 0, remaining: null};
    }
    if (data.type === 'closed') {
        const pot = Number.isFinite(Number(data.predicted_open_time)) ? Number(data.predicted_open_time) : null;
        const announceTs = Number.isFinite(pot) ? pot - ANNOUNCE_WINDOW_SEC : targetTs(server, snapshot);
        if (Number.isFinite(announceTs)) {
            const remaining = Math.max(0, announceTs - now);
            // 27-minute closed window until announcement
            const progress = clamp01(1 - (remaining / COOLDOWN_GAP_SEC));
            return {progress, remaining};
        }
        return {progress: 0, remaining: null};
    }
    return {progress: 0, remaining: null};
}

let serverIds = [];
let cards = {};

function snapshotState(snapshot) {
    if (!snapshot) return 'loading';
    if (snapshot.checking) return 'checking';
    if (snapshot.error) return 'error';
    const t = snapshot?.data?.type;
    if (t === 'open' || t === 'announced' || t === 'closed') return t;
    if (snapshot.loading) return 'loading';
    return 'unknown';
}

function pickBackground(snapshot) {
    const state = snapshotState(snapshot);
    if (state === 'closed') {
        return 'img/closed.png';
    }
    if (!(state === 'open' || state === 'announced')) return null;
    const name = snapshot?.data?.event?.name;
    if (typeof name !== 'string') return null;
    const lower = name.toLowerCase();
    if (lower.includes('pit')) return 'img/pits.png';
    if (lower.includes('vulture')) return 'img/vulture.png';
    if (lower.includes('canary')) return 'img/canary.png';
    return null;
}

function isLightMode() {
    try {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    } catch {
        return false;
    }
}

function applyCardBackground(card, snapshot) {
    const bg = pickBackground(snapshot);
    if (bg) {
        card.style.setProperty('--bg-image', `url("${bg}")`);
        const state = snapshotState(snapshot);
        //base
        let closedOpacity = 0.30;
        let otherOpacity = 0.40;

        //light mode offset
        if (isLightMode()) {
            closedOpacity += 0.2;
            otherOpacity += 0.2;
        }
        card.style.setProperty('--bg-opacity', state === 'closed' ? String(closedOpacity) : String(otherOpacity));
    } else {
        card.style.removeProperty('--bg-image');
        card.style.removeProperty('--bg-opacity');
    }
}

function applyCardState(card, snapshot) {
    const state = snapshotState(snapshot);
    card.className = `card state-${state}`;
    applyCardBackground(card, snapshot);
}

function renderAll() {
    clearError();
    let anyLoading = false;

    updateHeaderInfo();

    serverIds.forEach((id) => {
        const snapshot = last[id];

        let evtName = snapshot?.data?.event?.name;
        const st = snapshotState(snapshot);
        if (!evtName) {
            evtName = (st === 'closed') ? 'Closed' : '—';
        }
        if (nameEls[id]) nameEls[id].textContent = evtName;
        let statusText = '—';
        if (st === 'open') statusText = 'Open';
        else if (st === 'closed') statusText = 'Closed';
        else if (st === 'announced') statusText = 'Announced';
        else if (st === 'checking') statusText = 'Checking…';
        else if (st === 'loading') statusText = 'Loading…';
        else if (st === 'error') statusText = 'Error';
        if (statusEls[id]) {
            statusEls[id].textContent = statusText;
            statusEls[id].style.display = (st === 'closed') ? 'none' : '';
        }

        if (snapshot?.data?.type === 'open' && Number.isFinite(Number(snapshot?.data?.event?.close_time))) {
            lastCloseTime[id] = Number(snapshot.data.event.close_time);
        }

        const tgt = targetTs(id, snapshot);
        if (countdownEls[id]) countdownEls[id].textContent = typeof tgt === 'number' ? formatCooldown(tgt) : '—';
        const {progress} = computeProgress(id, snapshot);
        const circle = ringEls[id];
        const circ = ringCirc[id];
        if (circle && typeof circ === 'number') {
            const p = Number.isFinite(progress) ? clamp01(progress) : 0;
            const offset = circ * p;
            circle.setAttribute('stroke-dashoffset', String(offset));
        }

        const card = cards[id];
        if (card) applyCardState(card, snapshot);
        if (snapshot?.loading) anyLoading = true;

        startTimer(id, targetTs(id, snapshot), () => {
            const snap = last[id];
            const card2 = cards[id];
            if (card2) applyCardState(card2, snap);
            if (snap?.data?.type === 'open' && Number.isFinite(Number(snap?.data?.event?.close_time))) {
                lastCloseTime[id] = Number(snap.data.event.close_time);
            }
            const tgt2 = targetTs(id, snap);
            if (countdownEls[id]) countdownEls[id].textContent = typeof tgt2 === 'number' ? formatCooldown(tgt2) : '—';
            const st2 = snapshotState(snap);
            let statusText2 = '—';
            if (st2 === 'open') statusText2 = 'Open';
            else if (st2 === 'closed') statusText2 = 'Closed';
            else if (st2 === 'announced') statusText2 = 'Announced';
            else if (st2 === 'checking') statusText2 = 'Checking…';
            else if (st2 === 'loading') statusText2 = 'Loading…';
            else if (st2 === 'error') statusText2 = 'Error';
            if (statusEls[id]) {
                statusEls[id].textContent = statusText2;
                statusEls[id].style.display = (st2 === 'closed') ? 'none' : '';
            }
            const {progress: p2} = computeProgress(id, snap);
            const c = ringEls[id];
            const circ2 = ringCirc[id];
            if (c && typeof circ2 === 'number') {
                const off2 = circ2 * clamp01(Number.isFinite(p2) ? p2 : 0);
                c.setAttribute('stroke-dashoffset', String(off2));
            }
        });
    });
    setLoading(anyLoading);
}

/**
 * Request both servers' cached snapshots without forcing network fetches.
 */
function requestAllSnapshots() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({type: 'event-peeper:get-all'}, (resp) => {
            resolve(resp || {});
        });
    });
}

/**
 * Requests forced refresh for all servers.
 */
function requestRefreshAll() {
    setLoading(true);
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({type: 'event-peeper:refresh-all'}, (resp) => {
            resolve(resp || {});
        });
    });
}

/**
 * Requests current rate limit status from background.
 */
function requestRateLimitStatus() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({type: 'event-peeper:get-rate-limit'}, (resp) => {
            resolve(resp || {used: 0, max: 10});
        });
    });
}

function getServers() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({type: 'event-peeper:get-servers'}, (resp) => {
            resolve(Array.isArray(resp?.servers) ? resp.servers : []);
        });
    });
}

function ensureRow(server) {
    const id = server.server_id ?? server;
    const name = server.name ?? String(id);
    if (cards[id]) return cards[id];

    const card = document.createElement('div');
    card.id = `row-${id}`;
    card.className = 'card state-loading';

    // Header with server name and countdown ring
    const header = document.createElement('div');
    header.className = 'card-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'header-left';

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = name;

    const eventName = document.createElement('div');
    eventName.className = 'event-name';
    eventName.textContent = '—';

    headerLeft.appendChild(title);
    headerLeft.appendChild(eventName);
    const status = document.createElement('div');
    status.className = 'card-meta muted';
    status.textContent = '—';
    headerLeft.appendChild(status);

    const countdownWrap = document.createElement('div');
    countdownWrap.className = 'countdown-wrap';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('class', 'ring-track');
    track.setAttribute('cx', '32');
    track.setAttribute('cy', '32');
    track.setAttribute('r', '29');
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke-width', '6');
    const progress = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    progress.setAttribute('class', 'ring-progress');
    progress.setAttribute('cx', '32');
    progress.setAttribute('cy', '32');
    progress.setAttribute('r', '29');
    progress.setAttribute('fill', 'none');
    progress.setAttribute('stroke-width', '6');
    const circumference = 2 * Math.PI * 29;
    progress.setAttribute('stroke-dasharray', String(circumference));
    progress.setAttribute('stroke-dashoffset', '0');
    svg.appendChild(track);
    svg.appendChild(progress);
    const countdownText = document.createElement('div');
    countdownText.className = 'countdown-text';
    countdownText.textContent = '—';
    countdownWrap.appendChild(svg);
    countdownWrap.appendChild(countdownText);

    header.appendChild(headerLeft);
    header.appendChild(countdownWrap);


    card.appendChild(header);

    elems.rows?.appendChild(card);
    cards[id] = card;
    nameEls[id] = eventName;
    countdownEls[id] = countdownText;
    ringEls[id] = progress;
    ringCirc[id] = circumference;
    statusEls[id] = status;
    return card;
}

/**
 * Bootstraps the popup for dynamic display.
 */
async function initialize() {
    const servers = await getServers();
    if (Array.isArray(servers) && servers.length) {
        serverIds = servers.map(s => s.server_id);
        servers.forEach(s => ensureRow(s));
    }
    const resp = await requestAllSnapshots();
    if (resp && typeof resp === 'object') {
        Object.keys(resp).forEach((k) => {
            const id = Number(k);
            if (!Number.isNaN(id)) {
                if (!serverIds.includes(id)) {
                    serverIds.push(id);
                    ensureRow({server_id: id, name: String(id)});
                }
                last[id] = resp[id] || {loading: true};
                // Track the most recent update time
                if (resp[id]?.lastUpdated && resp[id].lastUpdated > lastGlobalUpdate) {
                    lastGlobalUpdate = resp[id].lastUpdated;
                }
            }
        });
    }

    rateLimitInfo = await requestRateLimitStatus();
    renderAll();

    setInterval(async () => {
        const newRateLimit = await requestRateLimitStatus();
        if (newRateLimit.used !== rateLimitInfo.used) {
            rateLimitInfo = newRateLimit;
        }
        updateHeaderInfo();
    }, 200);

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'event-peeper:update') {
            const p = msg.payload;
            if (typeof p?.server === 'number') {
                if (!serverIds.includes(p.server)) {
                    serverIds.push(p.server);
                    ensureRow({server_id: p.server, name: String(p.server)});
                }
                last[p.server] = p;
                // Update global last update time
                if (p.lastUpdated && p.lastUpdated > lastGlobalUpdate) {
                    lastGlobalUpdate = p.lastUpdated;
                }
                renderAll();
            }
        }
    });

    elems.refreshBtn?.addEventListener('click', async () => {
        const currentLimit = await requestRateLimitStatus();
        if (currentLimit.available <= 0) {
            return;
        }

        const resp2 = await requestRefreshAll();
        if (resp2 && typeof resp2 === 'object') {
            Object.keys(resp2).forEach((k) => {
                const id = Number(k);
                if (!Number.isNaN(id)) {
                    last[id] = resp2[id] || last[id];
                    // Update global last update time
                    if (resp2[id]?.lastUpdated && resp2[id].lastUpdated > lastGlobalUpdate) {
                        lastGlobalUpdate = resp2[id].lastUpdated;
                    }
                }
            });
        }
        renderAll();
    });
}

initialize();