<script>
    export let playback;
    export let connected;

    let metricItemId;
    let available = new Set();
    $: local = !!playback?.local;
    $: interrupted = !connected || !!playback?.error || ['disconnected', 'failed', 'closed'].includes(playback?.connectionState);
    $: stats = interrupted ? null : playback?.stats;
    $: values = {...stats, resolution: stats?.width && stats?.height ? `${stats.width}×${stats.height}` : null};
    $: rememberMetrics(playback?.itemId, values);
    $: status = interrupted ? 'Desktop disconnected' : stats
        ? local ? 'Encoder active' : 'Receiving desktop'
        : playback?.connectionState === 'connected' ? 'Statistics unavailable' : 'Connecting desktop';
    const limitations = {cpu: 'CPU limited', bandwidth: 'Bandwidth limited', other: 'Quality limited'};
    const bitrate = value => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)} Mbps` : `${Math.round(value / 1000)} kbps`;
    const metrics = [
        {key: 'bitrate', width: '12em', title: 'Video bitrate over the latest sample; excludes audio and transport headers',
            format: (value, local) => `${bitrate(value)} ${local ? 'sent' : 'received'}`},
        {key: 'encoderLoad', width: '11.5em',
            title: 'Estimated encoder load: time spent encoding divided by elapsed sample time. This is an encoding time estimate, not device CPU or GPU utilization.',
            format: value => `Encoder load ≈${Math.round(value)}%`},
        {key: 'encodeMs', width: '8em', title: 'Average time to encode a video frame over the latest sample',
            format: value => `${value.toFixed(1)} ms/frame`},
        {key: 'resolution', width: '6.5em', title: 'Video resolution'},
        {key: 'fps', width: '5em', title: 'Video frames per second', format: value => `${value.toFixed(1)} fps`},
        {key: 'codec', width: '4em', title: 'Video codec'},
        {key: 'encoder', width: '17em', title: 'Encoder implementation reported by your browser'},
        {key: 'powerEfficient', width: '11em',
            title: 'Browser-reported encoder power efficiency; this does not guarantee GPU acceleration',
            format: value => value ? 'Power efficient' : 'Not power efficient'},
        {key: 'limitation', width: '11em', title: 'Browser-reported reason for reducing encoded resolution or frame rate',
            format: value => value === 'none' ? 'No quality limit' : limitations[value] || 'Quality limited'},
        {key: 'rttMs', width: '7em', title: 'WebRTC round-trip time between this browser and the media relay',
            format: value => `${Math.round(value)} ms RTT`},
        {key: 'jitterMs', width: '8em', title: 'Variation in incoming video packet arrival times',
            format: value => `${value.toFixed(1)} ms jitter`},
        {key: 'packetLoss', width: '6.5em', title: 'Video packet loss over the latest sample',
            format: value => `${value.toFixed(1)}% loss`},
        {key: 'droppedFrames', width: '11em', title: 'Video frames dropped over the latest sample',
            format: value => `${value} dropped frames`},
    ];

    function rememberMetrics(itemId, values) {
        // Retain slots across missing samples, so a rate warming up after a
        // reconnect or suspended tab cannot move the neighboring metrics.
        const known = itemId === metricItemId ? available : new Set();
        metricItemId = itemId;
        available = new Set([...known, ...Object.keys(values).filter(key => values[key] != null)]);
    }
</script>

<div class="playback-health desktop-health" aria-label="Desktop stream statistics" data-direction={local ? 'outbound' : 'inbound'}>
    <span class="desktop-metric" data-metric="status" style="--metric-width: 13em">
        <span class="buffer-health-state" class:status-error={interrupted} title={status}>{status}</span>
    </span>
    {#each metrics.filter(metric => available.has(metric.key)) as metric (metric.key)}
        {@const value = values[metric.key]}
        {@const label = value == null ? '—' : metric.format ? metric.format(value, local) : value}
        <span class="desktop-metric" data-metric={metric.key} style={`--metric-width: ${metric.width}`}>
            <span title={`${metric.title}: ${label}`} class:status-error={metric.key === 'limitation' && value != null && value !== 'none'}>{label}</span>
        </span>
    {/each}
</div>

<style>
    .desktop-metric {
        flex: 0 0 var(--metric-width);
        width: var(--metric-width);
        max-width: 100%;
        min-width: 0;
    }

    .desktop-metric > span {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
</style>
