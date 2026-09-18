<script>
    import Icon from './Icon.svelte';

    export let item;
    export let playback = null;
    export let connected = false;
    export let volume = 0.8;
    export let muted = false;
    export let captureMuted = false;
    export let onRetry;
    let video;
    let blocked = false;
    let loading = true;
    let error = '';
    let generation = 0;

    $: forcedMute = captureMuted || !!playback?.local;
    $: if (video) video.volume = volume;
    $: if (video) video.muted = muted || forcedMute;

    async function play(node = video) {
        const current = generation;
        try {
            await node.play();
            if (current === generation) blocked = false;
        } catch (failure) {
            if (current !== generation) return;
            if (failure.name === 'NotAllowedError') blocked = true;
            else if (failure.name !== 'AbortError') error = 'This desktop could not be played. Retry playback.';
        }
    }

    function attachStream(node, initial) {
        let previousStream;
        let previousConnected;
        function update({stream, connected}) {
            if (stream === previousStream && connected === previousConnected) return;
            previousStream = stream;
            previousConnected = connected;
            generation++;
            blocked = false;
            error = '';
            loading = true;
            node.pause();
            node.srcObject = stream || null;
            node.muted = muted || captureMuted || !!playback?.local;
            node.volume = volume;
            if (stream && connected) void play(node);
        }
        update(initial);
        return {update, destroy() { generation++; node.pause(); node.srcObject = null; }};
    }
</script>

<div class="desktop-tile" data-item-id={item.id} data-local={!!playback?.local}>
    <!-- svelte-ignore a11y_media_has_caption (Live desktop capture has no caption track.) -->
    <video bind:this={video} use:attachStream={{stream: playback?.stream, connected}}
           controls playsinline aria-label={`Shared desktop: ${item.title}`}
           on:volumechange={() => { if (forcedMute && video && !video.muted) video.muted = true; }}
           on:loadeddata={() => loading = false} on:playing={() => { loading = false; error = ''; blocked = false; }}
           on:waiting={() => loading = true}
           on:error={() => error = 'This desktop could not be played. Retry playback.'}></video>
    <span class="desktop-name" title={item.title}>{item.addedBy || item.title}{playback?.local ? ' (you)' : ''}</span>
    {#if playback?.error || error}
        <div class="desktop-message" role="alert">
            <span>{playback?.error || error}</span>
            <button class="button secondary small" on:click={() => {
                error = '';
                if (playback?.local) void play();
                else onRetry?.(item.id);
            }}>Retry playback</button>
        </div>
    {:else if blocked}
        <div class="desktop-message">
            <button class="button primary small" on:click={() => play()}><Icon name="play" size={16}/>Enable playback</button>
        </div>
    {:else if loading}
        <div class="desktop-message" role="status"><span class="spinner"></span>Connecting desktop…</div>
    {/if}
</div>

<style>
    .desktop-tile {
        position: relative;
        flex: 0 0 calc((100% - (var(--desktop-columns) - 1) * 8px) / var(--desktop-columns));
        height: calc((100% - (var(--desktop-rows) - 1) * 8px) / var(--desktop-rows));
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: #050506;
        border-radius: 5px;
    }
    video { width: 100%; height: 100%; display: block; object-fit: contain; }
    .desktop-name {
        position: absolute;
        top: 7px;
        left: 8px;
        max-width: calc(100% - 16px);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 3px 7px;
        border-radius: 4px;
        background: #000b;
        color: #eee;
        font-size: 11px;
        pointer-events: none;
    }
    .desktop-message {
        position: absolute;
        inset: 30px 8px 38px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        overflow: auto;
        text-align: center;
        font-size: 12px;
        background: #050506df;
    }
</style>
