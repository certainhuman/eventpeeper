const model = globalThis.EventPeeperV2;
const elems = {
    content: document.getElementById('content'), error: document.getElementById('error'), refreshBtn: document.getElementById('refreshBtn'),
    serverRows: document.getElementById('serverRows'), pvpRows: document.getElementById('pvpRows'),
    lastUpdate: document.getElementById('lastUpdate'), activeEvents: document.getElementById('activeEvents'), missionsTab: document.getElementById('missionsTab'), pvpTab: document.getElementById('pvpTab'), missionsPage: document.getElementById('missionsPage'), pvpPage: document.getElementById('pvpPage'), apiUrlText: document.getElementById('apiUrlText'), versionText: document.getElementById('versionText')
};
let snapshot = {servers: {prod: [], test: []}, missionServers: {prod: [], test: []}, pvpEvents: [], loading: true, errors: {}};
let refreshInFlight = false;
function now() { return Math.floor(Date.now() / 1000); }
function setPage(page) {
    const pvp = page === 'pvp';
    elems.missionsPage.classList.toggle('hidden', pvp);
    elems.pvpPage.classList.toggle('hidden', !pvp);
    elems.missionsTab.classList.toggle('active', !pvp);
    elems.pvpTab.classList.toggle('active', pvp);
    elems.missionsTab.setAttribute('aria-selected', String(!pvp));
    elems.pvpTab.setAttribute('aria-selected', String(pvp));
}
function formatTime(seconds) {
    if (!Number.isFinite(Number(seconds))) return '—';
    const diff = Math.abs(Number(seconds) - now()), sign = Number(seconds) >= now() ? '' : '-';
    return sign + String(Math.floor(diff / 60)).padStart(2, '0') + ':' + String(diff % 60).padStart(2, '0');
}
function formatAbsoluteTime(seconds) {
    return new Intl.DateTimeFormat(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(new Date(Number(seconds) * 1000));
}
function formatPvpCountdown(seconds) {
    const diff = Math.max(0, Number(seconds) - now());
    if (diff >= 86400) {
        const days = Math.floor(diff / 86400);
        const hours = Math.ceil((diff % 86400) / 3600);
        return hours === 24 ? (days + 1) + 'd' : days + 'd' + (hours ? ' ' + hours + 'h' : '');
    }
    if (diff >= 3600) {
        const hours = Math.floor(diff / 3600);
        const minutes = Math.ceil((diff % 3600) / 60);
        return minutes === 60 ? (hours + 1) + 'h' : hours + 'h' + (minutes ? ' ' + minutes + 'm' : '');
    }
    if (diff >= 60) {
        const minutes = Math.floor(diff / 60);
        const secondsPart = Math.ceil(diff % 60);
        return secondsPart === 60 ? (minutes + 1) + 'm' : minutes + 'm' + (secondsPart ? ' ' + String(secondsPart).padStart(2, '0') + 's' : '');
    }
    return String(Math.ceil(diff)).padStart(2, '0') + 's';
}
function pvpCountdownTarget(start) {
    const startTime = Number(start);
    return startTime > now() ? startTime : startTime + 5 * 60;
}
function renderPvp() {
    clear(elems.pvpRows);
    const future = (snapshot.pvpEvents || []).filter(event => Number(event.start_unix) + 5 * 60 >= now());
    if (!future.length) { elems.pvpRows.textContent = 'No upcoming PvP events'; return; }
    for (const event of future) {
        const row = document.createElement('div'); row.className = 'pvp-row'; row.dataset.start = String(event.start_unix);
        const info = document.createElement('div'); info.className = 'pvp-event-info';
        const name = document.createElement('div'); name.className = 'pvp-event-server'; name.textContent = event.server_name || ('Server option ' + event.server_option_id);
        const absolute = document.createElement('div'); absolute.className = 'pvp-event-time muted'; absolute.textContent = formatAbsoluteTime(event.start_unix);
        info.append(name, absolute);
        const countdown = document.createElement('div'); countdown.className = 'pvp-event-countdown';
        const label = document.createElement('span'); label.className = 'pvp-event-label'; label.textContent = Number(event.start_unix) > now() ? 'Opens in' : 'Starts in';
        const value = document.createElement('span'); value.className = 'pvp-event-value'; value.textContent = formatPvpCountdown(pvpCountdownTarget(event.start_unix));
        countdown.append(label, value); row.append(info, countdown); elems.pvpRows.append(row);
    }
}
function updateCardTimers() {
    document.querySelectorAll('.card[data-status]').forEach(card => {
        const status = card.dataset.status;
        const openTime = Number(card.dataset.openTime), closeTime = Number(card.dataset.closeTime);
        const currentNow = now();
        let progress = 0, target = Number(card.dataset.target);
        if (status === 'open' && Number.isFinite(openTime) && Number.isFinite(closeTime) && closeTime > openTime) {
            progress = (currentNow - openTime) / (closeTime - openTime); target = closeTime;
        } else if (status === 'closed' && Number.isFinite(closeTime) && Number.isFinite(target) && target > closeTime) {
            progress = (currentNow - closeTime) / (target - closeTime);
        } else if (status === 'announced' && Number.isFinite(openTime)) {
            progress = 1 - Math.max(0, openTime - currentNow) / (3 * 60); target = openTime;
        } else if (status === 'inactive' && Number.isFinite(target)) {
            const inactiveWindow = Number(card.dataset.inactiveWindow) || 60;
            progress = (currentNow - (target - inactiveWindow)) / inactiveWindow;
        }
        progress = Math.max(0, Math.min(1, progress));
        const countdown = card.querySelector('.countdown-text');
        if (countdown && Number.isFinite(target)) countdown.textContent = formatTime(target);
        const nextOpen = Number(card.dataset.nextOpen), nextInline = card.querySelector('.next-inline');
        if (nextInline && Number.isFinite(nextOpen)) {
            nextInline.textContent = ' · Next: ' + (card.dataset.nextName || 'Mission') + ' · ' + formatTime(nextOpen);
        }
        const meta = card.querySelector('.card-meta');
        const ring = card.querySelector('.ring-progress');
        if (ring) ring.setAttribute('stroke-dashoffset', String(2 * Math.PI * 29 * progress));
    });
    document.querySelectorAll('.pvp-row[data-start]').forEach(row => {
        const start = Number(row.dataset.start), label = row.querySelector('.pvp-event-label');
        if (label) label.textContent = start > now() ? 'Opens in' : 'Starts in';
        const value = row.querySelector('.pvp-event-value');
        if (value) value.textContent = formatPvpCountdown(pvpCountdownTarget(start));
    });
    updateHeaderAge();
}
function updateHeaderAge() {
    const generated = Object.values(snapshot.generatedAt || {}).filter(Number.isFinite);
    const latest = generated.length ? Math.max(...generated) : null;
    elems.lastUpdate.textContent = latest ? formatTime(latest).replace('-', '') + ' ago' : '—';
}
function render() {
    clear(elems.serverRows);
    let open = 0, announced = 0, targets = [];
    for (const instance of ['prod', 'test']) {
        if ((snapshot.servers?.[instance] || []).length) {
            const separator = document.createElement('div'); separator.className = 'instance-separator';
            const separatorLabel = document.createElement('span'); separatorLabel.textContent = instance === 'test' ? 'TEST' : 'PRODUCTION';
            separator.append(separatorLabel); elems.serverRows.append(separator);
        }
        const missionMap = new Map((snapshot.missionServers?.[instance] || []).map(server => [server.server_id, server]));
        for (const server of snapshot.servers?.[instance] || []) {
            const missionServer = missionMap.get(server.server_id) || {...server, missions: []};
            const selection = model.selectMissions(missionServer);
            if (selection.current?.status === 'open') open++;
            if (selection.current?.status === 'announced') announced++;
            const card = createCard(server, missionServer); elems.serverRows.append(card);
            const target = Number(card.dataset.refreshTarget); if (target) targets.push(target);
        }
    }
    if (!elems.serverRows.children.length) elems.serverRows.textContent = 'No active servers';
    elems.activeEvents.textContent = open || announced ? open + ' open' + (announced ? ', ' + announced + ' announced' : '') : 'No events';
    renderPvp();
    updateHeaderAge();
    elems.content.classList.toggle('loading', !!snapshot.loading);
    const errors = Object.entries(snapshot.errors || {}).map(([key, value]) => key + ': ' + value);
    elems.error.style.display = errors.length && !generated.length ? 'block' : 'none';
    elems.error.textContent = errors.join('\\n');
    window.nextRefreshTarget = targets.concat((snapshot.pvpEvents || []).map(e => Number(e.start_unix)).filter(value => value >= now())).filter(Boolean).sort((a, b) => a - b)[0] || null;
}
function getVersion() { return new Promise(resolve => chrome.runtime.sendMessage({type: 'event-peeper:get-version'}, resolve)); }
function getSnapshot() { return new Promise(resolve => chrome.runtime.sendMessage({type: 'event-peeper:get-all'}, resolve)); }
function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true; elems.refreshBtn.disabled = true;
    chrome.runtime.sendMessage({type: 'event-peeper:refresh-all'}, result => {
        if (result) snapshot = result; refreshInFlight = false; elems.refreshBtn.disabled = false; render();
    });
}
async function initialize() {
    const version = await getVersion();
    elems.versionText.textContent = 'v' + (version?.version || '?');
    elems.apiUrlText.textContent = 'Data from ' + (version?.apiUrl || '').replace('https://', '');
    const cached = await getSnapshot(); if (cached) snapshot = cached; render(); updateCardTimers();
    setInterval(() => { updateCardTimers(); if (window.nextRefreshTarget && now() >= window.nextRefreshTarget && !refreshInFlight) refresh(); }, 1000);
    chrome.runtime.onMessage.addListener(message => { if (message?.type === 'event-peeper:update' && message.payload) { snapshot = message.payload; render(); } });
}
elems.refreshBtn?.addEventListener('click', refresh);
elems.missionsTab?.addEventListener('click', () => setPage('missions'));
elems.pvpTab?.addEventListener('click', () => setPage('pvp'));
initialize();
function missionName(mission) { return mission?.mission_name || 'Mission'; }
function backgroundFor(name, status) {
    if (status === 'closed') return 'img/closed.png';
    const lower = String(name || '').toLowerCase();
    if (lower.includes('pit')) return 'img/pits.png';
    if (lower.includes('vulture')) return 'img/vulture.png';
    if (lower.includes('canary')) return 'img/canary.png';
    return null;
}
function timerLabel(status) {
    if (status === 'inactive') return 'announced in';
    if (status === 'announced') return 'opens in';
    if (status === 'open') return 'closes in';
    if (status === 'closed') return 'concludes in';
    return '';
}
function clear(element) { while (element?.firstChild) element.removeChild(element.firstChild); }
function createCard(server, missionServer) {
    const selection = model.selectMissions(missionServer), current = selection.current;
    const status = current?.status || 'inactive', name = current ? missionName(current) : 'Inactive';
    const target = model.missionTarget(missionServer, selection);
    const refreshTarget = model.missionRefreshTarget(missionServer, selection);
    const card = document.createElement('div'); card.className = 'card state-' + status;
    const bg = backgroundFor(name, status); if (bg) card.style.setProperty('--bg-image', 'url(' + bg + ')');
    const header = document.createElement('div'); header.className = 'card-header';
    const left = document.createElement('div'); left.className = 'header-left';
    const title = document.createElement('div'); title.className = 'card-title';
    title.textContent = server.name || server.server_name || String(server.server_id);
    const event = document.createElement('div'); event.className = 'event-name'; event.textContent = current ? name : '\u00a0';
    const meta = document.createElement('div'); meta.className = 'card-meta muted';
    const statusLabel = current ? current.status[0].toUpperCase() + current.status.slice(1) : 'Inactive';
    meta.textContent = statusLabel;
    if (selection.next) {
        const nextInline = document.createElement('span'); nextInline.className = 'next-inline';
        nextInline.textContent = ' · Next: ' + missionName(selection.next) + ' · ' + formatTime(selection.next.open_time_unix);
        meta.append(nextInline);
    }
    left.append(title, event, meta); header.append(left);
    const wrap = document.createElement('div'); wrap.className = 'countdown-wrap';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 64 64');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('class', 'ring-track'); track.setAttribute('cx', '32'); track.setAttribute('cy', '32'); track.setAttribute('r', '29');
    track.setAttribute('fill', 'none'); track.setAttribute('stroke-width', '6');
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('class', 'ring-progress'); ring.setAttribute('cx', '32'); ring.setAttribute('cy', '32'); ring.setAttribute('r', '29');
    ring.setAttribute('fill', 'none'); ring.setAttribute('stroke-width', '6');
    const circumference = 2 * Math.PI * 29; ring.setAttribute('stroke-dasharray', String(circumference));
    const currentNow = now(); let progress = 0;
    if (current?.status === 'open') {
        const start = Number(current.open_time_unix), close = Number(current.close_time_unix);
        if (Number.isFinite(start) && Number.isFinite(close) && close > start) progress = (currentNow - start) / (close - start);
    } else if (current?.status === 'closed') {
        const closedAt = Number(current.close_time_unix);
        if (Number.isFinite(closedAt) && Number.isFinite(target) && target > closedAt) progress = (currentNow - closedAt) / (target - closedAt);
    } else if (current?.status === 'announced') {
        const openTime = Number(current.open_time_unix);
        if (Number.isFinite(openTime)) progress = 1 - Math.max(0, openTime - currentNow) / (3 * 60);
    } else if (status === 'inactive' && Number.isFinite(target)) {
        const inactiveWindow = server.instance === 'test' ? 60 : 27 * 60;
        progress = (currentNow - (target - inactiveWindow)) / inactiveWindow;
    }
    progress = Math.max(0, Math.min(1, progress));
    ring.setAttribute('stroke-dashoffset', String(circumference * progress));
    svg.append(track, ring);
    const countdown = document.createElement('div'); countdown.className = 'countdown-text'; countdown.textContent = formatTime(target);
    const label = document.createElement('div'); label.className = 'countdown-label'; label.textContent = timerLabel(status);
    wrap.append(svg, label, countdown); header.append(wrap); card.append(header);
    card.dataset.target = String(target || '');
    card.dataset.nextName = selection.next ? missionName(selection.next) : '';
    card.dataset.nextOpen = String(selection.next?.open_time_unix || '');
    card.dataset.refreshTarget = String(refreshTarget || '');
    card.dataset.status = status;
    card.dataset.openTime = String(current?.open_time_unix || '');
    card.dataset.closeTime = String(current?.close_time_unix || '');
    card.dataset.inactiveWindow = String(server.instance === 'test' ? 60 : 27 * 60);
    return card;
}
