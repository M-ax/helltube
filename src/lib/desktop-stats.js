const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;

// Desktop shares publish one video encoding. Sample counters from that RTP
// stream, excluding audio and repair streams, using the browser's timestamps.
export function createDesktopStats({outbound = true} = {}) {
    let previous = null;
    return {
        sample(report) {
            const entries = [...(report?.values() || [])];
            const byId = new Map(entries.map(entry => [entry.id, entry]));
            const video = entries.find(entry => entry.type === (outbound ? 'outbound-rtp' : 'inbound-rtp') &&
                !entry.isRemote && (entry.kind || entry.mediaType) === 'video' &&
                !/\/(rtx|red|ulpfec|flexfec-03)$/i.test(byId.get(entry.codecId)?.mimeType || ''));
            if (!video) { previous = null; return null; }
            const bytesKey = outbound ? 'bytesSent' : 'bytesReceived';
            const framesKey = outbound ? 'framesEncoded' : 'framesDecoded';
            const elapsed = previous && video.id === previous.id && video.ssrc === previous.ssrc &&
                video.codecId === previous.codecId ? (video.timestamp - previous.timestamp) / 1000 : 0;
            // Reconnects, counter resets and suspended tabs need a new baseline.
            const valid = Number.isFinite(elapsed) && elapsed > 0 && elapsed <= 5 &&
                !(video[bytesKey] < previous?.[bytesKey]) && !(video[framesKey] < previous?.[framesKey]);
            const delta = key => valid && nonnegative(video[key]) !== null && nonnegative(previous[key]) !== null
                ? nonnegative(video[key] - previous[key]) : null;
            const bytes = delta(bytesKey), frames = delta(framesKey);
            const encodeTime = outbound ? delta('totalEncodeTime') : null;
            const received = delta('packetsReceived'), lost = delta('packetsLost');
            const transport = byId.get(video.transportId);
            const pair = byId.get(transport?.selectedCandidatePairId);
            const remote = byId.get(video.remoteId);
            const rtt = nonnegative(pair?.currentRoundTripTime) ?? nonnegative(remote?.roundTripTime);
            const result = {
                bitrate: bytes === null ? null : bytes * 8 / elapsed,
                fps: nonnegative(video.framesPerSecond) ?? (frames === null ? null : frames / elapsed),
                width: nonnegative(video.frameWidth), height: nonnegative(video.frameHeight),
                codec: byId.get(video.codecId)?.mimeType?.replace(/^video\//i, '') || null,
                // Encode latency divided by elapsed time is an estimate of the
                // encoding time budget, not whole-device CPU/GPU utilization.
                encoderLoad: encodeTime === null ? null : encodeTime / elapsed * 100,
                encodeMs: encodeTime === null || !frames ? null : encodeTime / frames * 1000,
                encoder: outbound ? video.encoderImplementation || null : null,
                powerEfficient: outbound && typeof video.powerEfficientEncoder === 'boolean' ? video.powerEfficientEncoder : null,
                limitation: outbound ? video.qualityLimitationReason || null : null,
                rttMs: rtt === null ? null : rtt * 1000,
                jitterMs: !outbound && nonnegative(video.jitter) !== null ? video.jitter * 1000 : null,
                packetLoss: !outbound && received !== null && lost !== null && received + lost > 0
                    ? lost / (received + lost) * 100 : null,
                droppedFrames: outbound ? null : delta('framesDropped'),
            };
            previous = {...video};
            return result;
        },
    };
}
