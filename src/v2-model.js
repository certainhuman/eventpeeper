(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.EventPeeperV2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const INSTANCES = ['prod', 'test'];
    const CLOSED_DURATION_SECONDS = 60;
    function instanceValue(body, instance) { return body?.instances?.[instance] || {}; }
    function emptyInstances() { return {prod: [], test: []}; }
    function normalizeServers(body) {
        const result = emptyInstances();
        for (const instance of INSTANCES) {
            const servers = Array.isArray(instanceValue(body, instance).servers) ? instanceValue(body, instance).servers : [];
            result[instance] = servers.filter(s => s && s.active !== false && s.active !== 0)
                .map(s => ({...s, instance, name: s.server_name || String(s.server_id)}));
        }
        return result;
    }
    function serverLookup(servers) {
        const lookup = {};
        for (const instance of INSTANCES) for (const server of servers[instance] || []) lookup[instance + ':' + server.server_id] = server;
        return lookup;
    }
    function normalizeMissions(body, servers) {
        const lookup = serverLookup(servers), result = emptyInstances();
        for (const instance of INSTANCES) {
            const source = Array.isArray(instanceValue(body, instance).servers) ? instanceValue(body, instance).servers : [];
            result[instance] = source.map(data => {
                const server = lookup[instance + ':' + data.server_id] || {instance, server_id: data.server_id, name: data.server_name || String(data.server_id)};
                return {...server, ...data, instance, name: data.server_name || server.name, missions: Array.isArray(data.missions) ? data.missions : []};
            });
        }
        return result;
    }
    function normalizePvp(body, servers) {
        const lookup = serverLookup(servers);
        return (Array.isArray(body?.events) ? body.events : []).map(event => {
            const server = event.server_id == null ? null : lookup['prod:' + event.server_id];
            return {...event, server_name: server?.name || (event.server_id == null ? null : String(event.server_id)), instance: 'prod'};
        }).sort((a, b) => Number(a.start_unix || 0) - Number(b.start_unix || 0));
    }
    function createSnapshot({serversBody, missionsBody, pvpBody, generatedAt = {}, savedAt = Date.now(), errors = {}, loading = false}) {
        const servers = normalizeServers(serversBody || {});
        return {servers, missionServers: normalizeMissions(missionsBody || {}, servers), pvpEvents: normalizePvp(pvpBody || {}, servers),
            generatedAt: {servers: generatedAt.servers ?? serversBody?.generated_at_unix ?? null, missions: generatedAt.missions ?? missionsBody?.generated_at_unix ?? null, pvp: generatedAt.pvp ?? pvpBody?.generated_at_unix ?? null},
            savedAt, errors, loading};
    }
    function selectMissions(server, now = Math.floor(Date.now() / 1000)) {
        const missions = (server?.missions || []).filter(m => m && m.status !== 'concluded').slice().sort((a, b) => Number(a.open_time_unix || 0) - Number(b.open_time_unix || 0));
        const open = missions.filter(m => m.status === 'open');
        const closed = missions.filter(m => m.status === 'closed' && Number(m.open_time_unix || 0) <= now);
        const announced = missions.filter(m => m.status === 'announced');
        const current = open[0] || closed[closed.length - 1] || announced[0] || null;
        return {current, next: announced.find(m => m !== current) || null};
    }
    function missionTarget(server, selection) {
        const current = selection?.current;
        if (current?.status === 'announced') return Number(current.open_time_unix) || null;
        if (current?.status === 'open') return Number(current.close_time_unix) || null;
        if (current?.status === 'closed') {
            const closedAt = Number(current.close_time_unix);
            if (Number.isFinite(closedAt) && closedAt > 0) return closedAt + CLOSED_DURATION_SECONDS;
        }
        const nextOpen = Number(selection?.next?.open_time_unix || server?.next_open_time_unix || server?.next_predicted_open_time_unix);
        if (!current) return Number.isFinite(nextOpen) && nextOpen > 0 ? nextOpen - (3 * 60) : null;
        return Number.isFinite(nextOpen) && nextOpen > 0 ? nextOpen : null;
    }
    function missionRefreshTarget(server, selection) {
        const current = selection?.current;
        if (current?.status === 'announced') return Number(current.open_time_unix) || null;
        if (current?.status === 'open') return Number(current.close_time_unix) || null;
        if (current?.status === 'closed') {
            const closedAt = Number(current.close_time_unix);
            if (Number.isFinite(closedAt) && closedAt > 0) return closedAt + CLOSED_DURATION_SECONDS;
        }
        const nextOpen = Number(selection?.next?.open_time_unix || server?.next_open_time_unix || server?.next_predicted_open_time_unix);
        return Number.isFinite(nextOpen) && nextOpen > 0 ? nextOpen - (3 * 60) : null;
    }
    return {INSTANCES, CLOSED_DURATION_SECONDS, normalizeServers, normalizeMissions, normalizePvp, createSnapshot, selectMissions, missionTarget, missionRefreshTarget};
});
