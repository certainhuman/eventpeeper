// noinspection JSUnresolvedReference,GrazieInspection

const elems = {
  content: document.getElementById('content'),
  error: document.getElementById('error'),
  refreshBtn: document.getElementById('refreshBtn'),
  rows: document.getElementById('rows'),
};

let countdownTimers = {};
let nameEls = {};
let countdownEls = {};
let ringEls = {};
let ringCirc = {};

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
  // Manage spin finishing state
  if (!isLoading && header?.classList.contains('loading') && icon) {
    // ensure content loading state turns off immediately
    elems.content.classList.remove('loading');
    // Just transitioned from loading->not loading. Let the current spin finish.
    // Compute remaining time to next whole rotation (CSS duration is 600ms).
    const computed = getComputedStyle(icon);
    const durMs = 600; // must match @keyframes duration (spin 0.6s)
    let elapsedMs = 0;
    try {
      const m = computed.transform.match(/matrix\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(',').map(x => parseFloat(x.trim()));
        const a = parts[0], b = parts[1];
        // Angle from rotation matrix; not exact due to stroke drawing, but fine for UX.
        const angle = Math.atan2(b, a); // radians
        const frac = (angle < 0 ? (angle + 2*Math.PI) : angle) / (2*Math.PI);
        elapsedMs = frac * durMs;
      }
    } catch {}
    const remaining = Math.max(150, durMs - (elapsedMs % durMs));
    header.classList.remove('loading');
    header.classList.add('loading-done');
    header.classList.add('loaded'); // show the check immediately
    // Remove the finish-the-lap class after remaining time
    clearTimeout(setLoading._finishTimer);
    setLoading._finishTimer = setTimeout(() => {
      header.classList.remove('loading-done');
      // Keep the check visible briefly, then hide
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
  const tick = () => renderFn();
  countdownTimers[server] = setInterval(tick, 1000);
}



/**
 * Local store of last snapshots per server
 */
let last = {};

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

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

/**
 * Computes progress [0..1] and remaining seconds toward the relevant target, depending on state.
 * - open: progress from open_time to close_time
 * - announced: progress from first-seen remaining to 0
 * - closed: progress from first-seen remaining to 0 (using predicted_open_time if available)
 */
function computeProgress(server, snapshot){
  const data = snapshot?.data;
  if (!data) return { progress: 0, remaining: null };
  const now = Math.floor(Date.now()/1000);
  if (data.type === 'open') {
    const open = Number(data.event?.open_time);
    if (Number.isFinite(open)) {
      const close = open + OPEN_WINDOW_SEC;
      const remaining = Math.max(0, close - now);
      const progress = clamp01(1 - (remaining / OPEN_WINDOW_SEC));
      return { progress, remaining };
    }
    // Fallback: if API gave a concrete close_time, still treat as 15m total from now for visual consistency
    const t = Number(data.event?.close_time);
    if (Number.isFinite(t)) {
      const remaining = Math.max(0, t - now);
        const progress = clamp01(1 - (remaining / OPEN_WINDOW_SEC));
      return { progress, remaining };
    }
    return { progress: 0, remaining: null };
  }
  if (data.type === 'announced') {
    const effOpen = effectiveOpenTime(server, snapshot);
    if (Number.isFinite(effOpen)) {
      const remaining = Math.max(0, effOpen - now);
       // 3-minute announce window
        const progress = clamp01(1 - (remaining / ANNOUNCE_WINDOW_SEC));
      return { progress, remaining };
    }
    return { progress: 0, remaining: null };
  }
  if (data.type === 'closed') {
    const pot = Number.isFinite(Number(data.predicted_open_time)) ? Number(data.predicted_open_time) : null;
    const announceTs = Number.isFinite(pot) ? pot - ANNOUNCE_WINDOW_SEC : targetTs(server, snapshot);
    if (Number.isFinite(announceTs)) {
      const remaining = Math.max(0, announceTs - now);
       // 27-minute closed window until announcement
        const progress = clamp01(1 - (remaining / COOLDOWN_GAP_SEC));
      return { progress, remaining };
    }
    return { progress: 0, remaining: null };
  }
  return { progress: 0, remaining: null };
}

let serverIds = [];
let cards = {};

function snapshotState(snapshot) {
  if (!snapshot) return 'loading';
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

function applyCardBackground(card, snapshot) {
  const bg = pickBackground(snapshot);
  if (bg) {
    card.style.setProperty('--bg-image', `url("${bg}")`);
    const state = snapshotState(snapshot);
    card.style.setProperty('--bg-opacity', state === 'closed' ? '0.28' : '0.20');
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
  serverIds.forEach((id) => {
    const snapshot = last[id];

    // Update event name
    let evtName = snapshot?.data?.event?.name;
    const t = snapshot?.data?.type;
    if (!evtName) {
      if (t === 'closed') evtName = 'Closed';
      else if (t === 'announced') evtName = 'Announced';
      else if (t === 'open') evtName = 'Open';
      else evtName = '—';
    }
    if (nameEls[id]) nameEls[id].textContent = evtName;

    // Update countdown text and ring
    // record last known close time for 27-minute cooldown reference
    if (snapshot?.data?.type === 'open' && Number.isFinite(Number(snapshot?.data?.event?.close_time))) {
      lastCloseTime[id] = Number(snapshot.data.event.close_time);
    }

    const tgt = targetTs(id, snapshot);
    if (countdownEls[id]) countdownEls[id].textContent = typeof tgt === 'number' ? formatCooldown(tgt) : '—';
    const { progress } = computeProgress(id, snapshot);
    const circle = ringEls[id];
    const circ = ringCirc[id];
    if (circle && typeof circ === 'number') {
      const p = Number.isFinite(progress) ? clamp01(progress) : 0;
      // Countdown ring: start full (offset 0) and shrink to empty (offset circ)
      const offset = circ * p;
      circle.setAttribute('stroke-dashoffset', String(offset));
    }

    const card = cards[id];
    if (card) applyCardState(card, snapshot);
    if (snapshot?.loading) anyLoading = true;

    // Keep the live countdown updating each second
    startTimer(id, targetTs(id, snapshot), () => {
      const snap = last[id];
      const card2 = cards[id];
      if (card2) applyCardState(card2, snap);
      // record last known close time continuously while open
      if (snap?.data?.type === 'open' && Number.isFinite(Number(snap?.data?.event?.close_time))) {
        lastCloseTime[id] = Number(snap.data.event.close_time);
      }
      const tgt2 = targetTs(id, snap);
      if (countdownEls[id]) countdownEls[id].textContent = typeof tgt2 === 'number' ? formatCooldown(tgt2) : '—';
      const { progress: p2 } = computeProgress(id, snap);
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
    chrome.runtime.sendMessage({ type: 'event-peeper:get-all' }, (resp) => {
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
    chrome.runtime.sendMessage({ type: 'event-peeper:refresh-all' }, (resp) => {
      resolve(resp || {});
    });
  });
}

function getServers() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'event-peeper:get-servers' }, (resp) => {
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
          ensureRow({ server_id: id, name: String(id) });
        }
        last[id] = resp[id] || { loading: true };
      }
    });
  }
  renderAll();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'event-peeper:update') {
      const p = msg.payload;
      if (typeof p?.server === 'number') {
        if (!serverIds.includes(p.server)) {
          serverIds.push(p.server);
          ensureRow({ server_id: p.server, name: String(p.server) });
        }
        last[p.server] = p;
        renderAll();
      }
    }
  });

  elems.refreshBtn?.addEventListener('click', async () => {
    const resp2 = await requestRefreshAll();
    if (resp2 && typeof resp2 === 'object') {
      Object.keys(resp2).forEach((k) => {
        const id = Number(k);
        if (!Number.isNaN(id)) last[id] = resp2[id] || last[id];
      });
    }
    renderAll();
  });
}

initialize();
