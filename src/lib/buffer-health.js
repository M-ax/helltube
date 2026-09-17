// Only count the contiguous range containing the playhead; future ranges cannot bridge a stall.
export function bufferAhead(ranges, position) {
    if (!Number.isFinite(position) || position < 0) return 0;
    for (let i = 0; i < (ranges?.length || 0); i++) {
        if (ranges.start(i) <= position && ranges.end(i) > position) return ranges.end(i) - position;
    }
    return 0;
}

export function createBufferHealth({now = () => performance.now()} = {}) {
    let graceUntil = now() + 4000;
    let lowSince = null;
    let stalledSince = null;
    let lastSample = null;
    let revision;
    let transfers = [];

    function fragmentLoaded(frag) {
        const elapsed = frag?.stats?.loading?.end - frag?.stats?.loading?.start;
        const bytes = frag?.stats?.loaded;
        if (![elapsed, bytes, frag?.duration].every(value => Number.isFinite(value) && value > 0)) return;
        transfers.push({at: now(), elapsed, bytes, duration: frag.duration});
        transfers = transfers.slice(-5);
    }

    function sample({ranges, currentTime, target, serverAhead, remaining = Infinity, complete = false,
        active = true, paused = false, blocked = false, seeking = false, buffering = false,
        playbackRate = 1, playbackRevision}) {
        const at = now();
        // Room seeks and throttled/suspended tabs need a fresh observation window.
        if (revision !== playbackRevision || (lastSample !== null && at - lastSample > 2500)) {
            graceUntil = at + 4000;
            lowSince = stalledSince = null;
        }
        revision = playbackRevision;
        lastSample = at;
        const seconds = Math.min(bufferAhead(ranges, currentTime), bufferAhead(ranges, target));
        const playableSeconds = seconds / Math.max(1, playbackRate || 1);
        const sourceAhead = Math.max(0, Number.isFinite(serverAhead) ? serverAhead : 0);
        const coveredEnd = complete && remaining <= seconds + 0.5;
        const sourceLimited = !coveredEnd && (complete
            ? sourceAhead <= seconds + 0.5 : sourceAhead < Math.max(4, seconds + 2));
        const observing = active && !paused && !blocked && !seeking && !coveredEnd && !sourceLimited;
        const low = observing && playableSeconds < 6;
        const stalled = low && buffering && playableSeconds < 0.5;
        lowSince = low ? (lowSince ?? at) : null;
        stalledSince = stalled ? (stalledSince ?? at) : null;
        const fallbackReason = at < graceUntil ? null
            : stalledSince !== null && at - stalledSince >= 3000 ? 'Playback stalled'
            : lowSince !== null && at - lowSince >= 6000 ? 'Buffer stayed low' : null;
        transfers = transfers.filter(transfer => at - transfer.at < 15000);
        const totals = transfers.reduce((sum, transfer) => ({bytes: sum.bytes + transfer.bytes,
            elapsed: sum.elapsed + transfer.elapsed, duration: sum.duration + transfer.duration}),
        {bytes: 0, elapsed: 0, duration: 0});
        const status = !active ? 'Waiting for connection' : blocked ? 'Playback needs permission'
            : paused ? 'Paused' : seeking ? 'Seeking' : coveredEnd ? 'Buffered to end'
            : sourceLimited ? 'Waiting for source' : buffering && seconds < 0.5 ? 'Buffering'
            : playableSeconds < 6 ? 'Low buffer' : 'Healthy buffer';
        return {seconds, serverAhead: sourceAhead, status, fallbackReason,
            mbps: totals.elapsed ? totals.bytes * 8 / totals.elapsed / 1000 : null,
            downloadRate: totals.elapsed ? totals.duration * 1000 / totals.elapsed : null};
    }

    return {sample, fragmentLoaded};
}

export function isProxyLoadFailure(data, source) {
    if (!/^(manifest|level|frag)Load(Error|TimeOut)$/.test(data?.details || '')) return false;
    const status = data.response?.code;
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
    const url = data.frag?.url || data.context?.url || data.url;
    if (!url) return false;
    try {
        const expected = new URL(source);
        const actual = new URL(url, source);
        return actual.origin === expected.origin && actual.pathname.startsWith(expected.pathname.replace('index.m3u8', ''));
    } catch { return false; }
}
