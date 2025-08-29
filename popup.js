const elems = {
  content: document.getElementById('content'),
  status: document.getElementById('status'),
  details: document.getElementById('details'),
  eventRow: document.getElementById('eventRow'),
  timeRow: document.getElementById('timeRow'),
  closeRow: document.getElementById('closeRow'),
  eventName: document.getElementById('eventName'),
  timeLabel: document.getElementById('timeLabel'),
  timeValue: document.getElementById('timeValue'),
  closeTime: document.getElementById('closeTime'),
  countdownRow: document.getElementById('countdownRow'),
  countdown: document.getElementById('countdown'),
  error: document.getElementById('error'),
  refreshBtn: document.getElementById('refreshBtn'),
};

let countdownTimer = null;

/**
 * Formats a UNIX timestamp (in seconds) into a localized date/time string.
 * @param {number} tsSec - UNIX timestamp in seconds.
 * @returns {string} Localized date/time, or an empty string if input is not a number.
 */
function formatDate(tsSec) {
  if (typeof tsSec !== 'number') return '';
  const d = new Date(tsSec * 1000);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
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
 * Stops the active countdown interval, if any, and clears the timer handle.
 */
function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/**
 * Starts a 1-second interval to update the countdown display until cleared.
 * If no target is provided, the countdown row is hidden.
 * @param {number} targetTsSec - Target UNIX timestamp in seconds.
 */
function startCountdown(targetTsSec) {
  stopCountdown();
  if (!targetTsSec) {
    elems.countdownRow.style.display = 'none';
    return;
  }
  const update = () => {
    elems.countdown.textContent = formatCooldown(targetTsSec);
  };
  elems.countdownRow.style.display = '';
  update();
  countdownTimer = setInterval(update, 1000);
}

/**
 * Renders the popup UI based on the API response payload.
 * Controls which rows are shown, sets labels/values, and starts/stops countdowns.
 * @param {{type:string,event?:{id:number,event_type_id:number,name:string,open_time:number,close_time?:number},predicted_open_time?:number}} data
 */
function render(data) {
  clearError();
  stopCountdown();

  const type = data?.type;
  elems.details.style.display = 'none';
  if (elems.eventRow) elems.eventRow.style.display = 'none';
  if (elems.timeRow) elems.timeRow.style.display = 'none';
  if (elems.closeRow) elems.closeRow.style.display = 'none';
  elems.closeTime.textContent = '';
  elems.eventName.textContent = '';
  elems.timeLabel.textContent = '';
  elems.timeValue.textContent = '';
  elems.countdownRow.style.display = 'none';

  if (type === 'open') {
    elems.status.textContent = 'Open';
    elems.details.style.display = '';
    if (elems.eventRow) elems.eventRow.style.display = '';
    if (elems.timeRow) elems.timeRow.style.display = '';
    elems.eventName.textContent = data.event?.name ?? '';
    elems.timeLabel.textContent = 'Opened:';
    elems.timeValue.textContent = formatDate(data.event?.open_time);
    if (data.event?.close_time) {
      if (elems.closeRow) elems.closeRow.style.display = '';
      elems.closeTime.textContent = formatDate(data.event.close_time);
      startCountdown(data.event.close_time);
    }
  } else if (type === 'announced') {
    elems.status.textContent = 'Announced';
    elems.details.style.display = '';
    if (elems.eventRow) elems.eventRow.style.display = '';
    if (elems.timeRow) elems.timeRow.style.display = '';
    elems.eventName.textContent = data.event?.name ?? '';
    elems.timeLabel.textContent = 'Opens:';
    elems.timeValue.textContent = formatDate(data.event?.open_time);
    if (data.event?.close_time) {
      if (elems.closeRow) elems.closeRow.style.display = '';
      elems.closeTime.textContent = formatDate(data.event.close_time);
    }
    if (data.event?.open_time) startCountdown(data.event.open_time);
  } else if (type === 'closed') {
    elems.status.textContent = 'Closed';
    if (typeof data.predicted_open_time === 'number') {
      elems.details.style.display = '';
      if (elems.timeRow) elems.timeRow.style.display = '';
      elems.timeLabel.textContent = 'Predicted open:';
      elems.timeValue.textContent = formatDate(data.predicted_open_time);
      startCountdown(data.predicted_open_time);
    }
  } else {
    elems.status.textContent = 'Unknown response';
    showError('Unexpected response format from API.');
  }
}


/**
 * Applies a snapshot from the background cache to the popup UI.
 * Updates loading/error states and re-renders when data is present.
 * @param {{data?:any,error?:string,loading?:boolean,lastUpdated?:number}} snapshot
 */
function applySnapshot(snapshot) {
  const { data, error, loading } = snapshot || {};
  setLoading(!!loading);
  clearError();
  if (error) showError(error);
  if (data) {
    render(data);
  }
}

/**
 * Requests the latest cached snapshot from the background script without forcing a network fetch.
 * The background may still perform a fetch if its cache is considered stale.
 * @returns {Promise<{data?:any,error?:string,loading?:boolean,lastUpdated?:number}>}
 */
function requestSnapshot() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'event-peeper:get' }, (resp) => {
      resolve(resp || {});
    });
  });
}

/**
 * Requests a forced refresh from the background script to fetch fresh data from the API.
 * Shows loading state while waiting for the response.
 * @returns {Promise<{data?:any,error?:string,loading?:boolean,lastUpdated?:number}>}
 */
function requestRefresh() {
  setLoading(true);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'event-peeper:refresh', forced: true }, (resp) => {
      resolve(resp || {});
    });
  });
}

/**
 * Bootstraps the popup: wires message listeners, refresh button, and initial snapshot load.
 * Does not perform any direct network requests; delegates to the background script.
 */
function initialize() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'event-peeper:update') {
      applySnapshot(msg.payload);
    }
  });

  elems.refreshBtn?.addEventListener('click', async () => {
    const snap = await requestRefresh();
    applySnapshot(snap);
  });

  requestSnapshot().then(applySnapshot);
}

initialize();
