<script>
    import Icon from './Icon.svelte';

    export let item;
    export let playback = null;
    export let connected = false;
    export let volume = 0.8;
    export let muted = false;
    export let captureMuted = false;
    export let inputDisabled = false;
    export let visualized = false;
    export let nativeControls = true;
    export let onRetry;
    export let onRetryVideo;
    let tile;
    let video;
    let fullscreen = false;
    let fullscreenPending = false;
    let fullscreenError = '';
    let blocked = false;
    let loading = true;
    let error = '';
    let generation = 0;

    $: forcedMute = captureMuted || !!playback?.local;
    $: if (video) video.volume = volume;
    $: if (video) video.muted = muted || forcedMute;

    async function toggleFullscreen() {
        if (fullscreenPending || (inputDisabled && !fullscreen)) return;
        fullscreenPending = true;
        fullscreenError = '';
        try {
            if (document.fullscreenElement === tile) await document.exitFullscreen();
            // Keep the MediaStream video in its normal playback mode. Only its
            // surrounding tile enters fullscreen; the decoder and capture stay attached.
            else if (tile.requestFullscreen) await tile.requestFullscreen();
            else fullscreenError = 'Fullscreen is not available in this browser.';
        } catch {
            fullscreenError = 'Fullscreen was blocked. Try again.';
        } finally { fullscreenPending = false; }
    }

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

<svelte:document on:fullscreenchange={() => fullscreen = document.fullscreenElement === tile}/>

<div class="desktop-tile" class:visualized bind:this={tile} data-item-id={item.id} data-local={!!playback?.local}>
    <!-- svelte-ignore a11y_media_has_caption (Live desktop capture has no caption track.) -->
    <video bind:this={video} use:attachStream={{stream: playback?.stream, connected}}
           controls={nativeControls && !inputDisabled && !visualized} controlslist="nofullscreen" inert={inputDisabled || visualized || !nativeControls} playsinline aria-label={`Shared desktop: ${item.title}`}
           on:dblclick|preventDefault={toggleFullscreen}
           on:volumechange={() => { if (forcedMute && video && !video.muted) video.muted = true; }}
           on:loadeddata={() => loading = false} on:playing={() => { loading = false; error = ''; blocked = false; }}
           on:waiting={() => loading = true}
           on:error={() => error = 'This desktop could not be played. Retry playback.'}></video>
    <span class="desktop-name" title={item.title}>{item.addedBy || item.title}{playback?.local ? ' (you)' : ''}</span>
    {#if nativeControls}<button class="icon-button desktop-fullscreen" type="button"
            aria-label={fullscreen ? 'Exit fullscreen' : `Fullscreen ${item.title}`} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen this desktop'}
            disabled={fullscreenPending || (inputDisabled && !fullscreen)} on:click={toggleFullscreen}>
        <Icon name="fullscreen" size={17}/>
    </button>{/if}
    {#if fullscreenError}<p class="desktop-fullscreen-error" role="status">{fullscreenError}</p>{/if}
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
    {:else if playback?.videoError}
        <div class="desktop-message" role="alert">
            <span>{playback.videoError}</span>
            <button class="button secondary small" on:click={() => onRetryVideo?.(item.id)}>Retry video</button>
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
    .visualized video { opacity: 0; }
    .visualized .desktop-name, .visualized .desktop-fullscreen { display: none; }
    video::-webkit-media-controls-fullscreen-button { display: none; }
    .desktop-tile:fullscreen { width: 100%; height: 100%; border-radius: 0; }
    .desktop-tile::backdrop { background: #050506; }
    .desktop-fullscreen {
        position: absolute;
        top: 7px;
        right: 8px;
        z-index: 1;
        width: 30px;
        height: 30px;
        background: #000b;
        color: #eee;
    }
    .desktop-fullscreen-error {
        position: absolute;
        top: 40px;
        right: 8px;
        left: 8px;
        margin: 0;
        padding: 5px 8px;
        background: #000d;
        font-size: 12px;
    }
    .desktop-name {
        position: absolute;
        top: 7px;
        left: 8px;
        max-width: calc(100% - 56px);
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
        z-index: 2;
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
