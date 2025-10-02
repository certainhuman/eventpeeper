const elems = {
  content: document.getElementById('content'),
  error: document.getElementById('error'),
  refreshBtn: document.getElementById('refreshBtn'),
  summary0: document.getElementById('summary-0'),
  summary1: document.getElementById('summary-1'),
};

let countdownTimers = { 0: null, 1: null };

/**
 * Formats a UNIX timestamp (in seconds) to HH:MM in local time.
 */
function hhmm(tsSec) {
  if (typeof tsSec !== 'number') return '';
  const d = new Date(tsSec * 1000);
  // Prefer 12-hour without leading zero, falling back to locale default if unsupported
  // Many browsers respect hourCycle: 'h12' which yields 1:30 AM instead of 01:30 AM.
  try {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true, hourCycle: 'h12' });
  } catch {
    // Fallback: use hour:'numeric' and minute:'2-digit' (most locales will omit leading zero in 12h if hour12 true)
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  }
}

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
  elems.content.classList.toggle('loading', isLoading);
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
 * Manage per-server countdown intervals that re-render the concise summary.
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
 * Build concise text for one server snapshot
 */
function buildSummary(snapshot) {
  if (!snapshot) return 'Loading…';
  const { data, error, loading } = snapshot;
  if (error) return error;
  if (loading && !data) return 'Loading…';
  const type = data?.type;
  const evt = data?.event || {};
  const name = evt?.name || 'Unknown';
  if (type === 'open') {
    const open = hhmm(evt.open_time);
    const close = typeof evt.close_time === 'number' ? hhmm(evt.close_time) : '';
    const range = close ? `${open}-${close}` : `${open}`;
    const tail = typeof evt.close_time === 'number' ? `, closes in ${formatCooldown(evt.close_time)}` : '';
    return `${name}, ${range}${tail}`;
  }
  if (type === 'announced') {
    const open = hhmm(evt.open_time);
    const close = typeof evt.close_time === 'number' ? `-${hhmm(evt.close_time)}` : '';
    const tail = typeof evt.open_time === 'number' ? `, opens in ${formatCooldown(evt.open_time)}` : '';
    return `${name}, ${open}${close}${tail}`;
  }
  if (type === 'closed') {
    if (typeof data.predicted_open_time === 'number') {
      return `Closed, opens at ${hhmm(data.predicted_open_time)}, in ${formatCooldown(data.predicted_open_time)}`;
    }
    return 'Closed';
  }
  return 'Unknown';
}


/**
 * Local store of last snapshots per server
 */
const last = { 0: null, 1: null };

function targetTs(snapshot) {
  const data = snapshot?.data;
  if (!data) return null;
  if (data.type === 'open') return data.event?.close_time || null;
  if (data.type === 'announced') return data.event?.open_time || null;
  if (data.type === 'closed') return typeof data.predicted_open_time === 'number' ? data.predicted_open_time : null;
  return null;
}

function renderAll() {
  clearError();
  const s0 = buildSummary(last[0]);
  const s1 = buildSummary(last[1]);
  if (elems.summary0) elems.summary0.textContent = s0;
  if (elems.summary1) elems.summary1.textContent = s1;
  const l0 = !!last[0]?.loading;
  const l1 = !!last[1]?.loading;
  setLoading(l0 || l1);
  // timers
  startTimer(0, targetTs(last[0]), () => {
    if (elems.summary0) elems.summary0.textContent = buildSummary(last[0]);
  });
  startTimer(1, targetTs(last[1]), () => {
    if (elems.summary1) elems.summary1.textContent = buildSummary(last[1]);
  });
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
 * Requests forced refresh for both servers.
 */
function requestRefreshAll() {
  setLoading(true);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'event-peeper:refresh-all' }, (resp) => {
      resolve(resp || {});
    });
  });
}

/**
 * Bootstraps the popup for dual-server concise display.
 */
function initialize() {
  // Initial aggregate load
  requestAllSnapshots().then((resp) => {
    last[0] = resp?.[0] || { loading: true };
    last[1] = resp?.[1] || { loading: true };
    renderAll();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'event-peeper:update') {
      const p = msg.payload;
      if (typeof p?.server === 'number' && (p.server === 0 || p.server === 1)) {
        last[p.server] = p;
        renderAll();
      }
    }
  });

  elems.refreshBtn?.addEventListener('click', async () => {
    const resp = await requestRefreshAll();
    last[0] = resp?.[0] || last[0];
    last[1] = resp?.[1] || last[1];
    renderAll();
  });
}

initialize();
