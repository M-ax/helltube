<script>
    export let playback;
    export let connected;

    $: local = !!playback?.local;
    $: interrupted = !connected || !!playback?.error || ['disconnected', 'failed', 'closed'].includes(playback?.connectionState);
    $: stats = interrupted ? null : playback?.stats;
    $: limited = stats?.limitation && stats.limitation !== 'none';
    $: status = interrupted ? 'Desktop disconnected' : stats
        ? local ? 'Encoder active' : 'Receiving desktop'
        : playback?.connectionState === 'connected' ? 'Statistics unavailable' : 'Connecting desktop';
    const limitations = {cpu: 'CPU limited', bandwidth: 'Bandwidth limited', other: 'Quality limited'};
    const bitrate = value => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)} Mbps` : `${Math.round(value / 1000)} kbps`;
</script>

<div class="playback-health desktop-health" aria-label="Desktop stream statistics" data-direction={local ? 'outbound' : 'inbound'}>
    <span class="buffer-health-state" class:status-error={interrupted}>{status}</span>
    {#if stats}
        {#if stats.bitrate !== null}
            <span title="Video bitrate over the latest sample; excludes audio and transport headers">{bitrate(stats.bitrate)} {local ? 'sent' : 'received'}</span>
        {/if}
        {#if stats.encoderLoad !== null}
            <span title="Estimated encoder load: time spent encoding divided by elapsed sample time. This is an encoding time estimate, not device CPU or GPU utilization.">Encoder load ≈{Math.round(stats.encoderLoad)}%</span>
        {/if}
        {#if stats.encodeMs !== null}
            <span title="Average time to encode a video frame over the latest sample">{stats.encodeMs.toFixed(1)} ms/frame</span>
        {/if}
        {#if stats.width && stats.height}<span>{stats.width}×{stats.height}</span>{/if}
        {#if stats.fps !== null}<span>{stats.fps.toFixed(1)} fps</span>{/if}
        {#if stats.codec}<span>{stats.codec}</span>{/if}
        {#if stats.encoder}<span title="Encoder implementation reported by your browser">{stats.encoder}</span>{/if}
        {#if stats.powerEfficient !== null}
            <span title="Browser-reported encoder power efficiency; this does not guarantee GPU acceleration">{stats.powerEfficient ? 'Power efficient' : 'Not power efficient'}</span>
        {/if}
        {#if stats.limitation}
            <span class:status-error={limited} title="Browser-reported reason for reducing encoded resolution or frame rate">{limited ? limitations[stats.limitation] || 'Quality limited' : 'No quality limit'}</span>
        {/if}
        {#if stats.rttMs !== null}<span title="WebRTC round-trip time between this browser and the media relay">{Math.round(stats.rttMs)} ms RTT</span>{/if}
        {#if stats.jitterMs !== null}<span title="Variation in incoming video packet arrival times">{stats.jitterMs.toFixed(1)} ms jitter</span>{/if}
        {#if stats.packetLoss !== null}<span title="Video packet loss over the latest sample">{stats.packetLoss.toFixed(1)}% loss</span>{/if}
        {#if stats.droppedFrames !== null}<span title="Video frames dropped over the latest sample">{stats.droppedFrames} dropped frames</span>{/if}
    {/if}
</div>
