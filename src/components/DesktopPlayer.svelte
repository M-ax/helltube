<script>
    import {onMount, onDestroy} from 'svelte';
    import Icon from './Icon.svelte';
    import {waitForDesktopFrame} from '../lib/desktop-video-ready.js';

    export let item;
    export let playback = null;
    export let connected = false;
    export let volume = 0.8;
    export let muted = false;
    export let captureMuted = false;
    export let audioAnalysis;
    export let bassBoost = false;
    export let inputDisabled = false;
    export let visualized = false;
    export let nativeControls = true;
    export let focusAvailable = false;
    export let focused = false;
    export let thumbnail = false;
    export let onFocus;
    export let videoRequested = false;
    export let onVideoReady;
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
    let videoReady = false;
    let boostedStream = null;
    let originalAudioStream = null;
    let audioGeneration = 0;
    let hidden = false;
    let individuallyMuted = false;
    let appliedMuted = false;

    $: forcedMute = captureMuted || !!playback?.local;
    $: if (video) video.volume = volume;
    $: if (video) applyMute(video, muted || forcedMute, individuallyMuted);
    $: updateBassBoost(playback?.stream, bassBoost && connected && !forcedMute && !hidden, audioAnalysis);
    $: renderedStream = boostedStream && boostedStream.original === playback?.stream ? boostedStream.stream : playback?.stream;

    function applyMute(node, masterMuted, streamMuted) {
        appliedMuted = masterMuted || streamMuted;
        node.muted = appliedMuted;
    }

    function rememberMute() {
        // Volume and mute writes queue the same event. Only a native mute change
        // that differs from our last applied value is an individual preference.
        if (!video || video.muted === appliedMuted) return;
        if (muted || forcedMute) {
            video.muted = true;
            return;
        }
        individuallyMuted = video.muted;
        appliedMuted = video.muted;
    }

    async function updateBassBoost(stream, enabled, analysis, gesture = false) {
        const version = ++audioGeneration;
        if (stream !== originalAudioStream) {
            analysis?.releaseStream(originalAudioStream);
            originalAudioStream = stream;
            boostedStream = null;
        }
        if (!stream || !analysis) return;
        try {
            const processed = await analysis.boostStream(stream, enabled, gesture);
            if (version === audioGeneration) boostedStream = {original: stream, stream: processed};
        } catch { /* Keep native desktop playback when Web Audio is unavailable. */ }
    }

    onMount(() => {
        const visibility = () => hidden = document.hidden;
        const gesture = () => void updateBassBoost(playback?.stream, bassBoost && connected && !forcedMute && !document.hidden, audioAnalysis, true);
        document.addEventListener('visibilitychange', visibility);
        document.addEventListener('pointerdown', gesture);
        document.addEventListener('keydown', gesture);
        visibility();
        return () => {
            document.removeEventListener('visibilitychange', visibility);
            document.removeEventListener('pointerdown', gesture);
            document.removeEventListener('keydown', gesture);
        };
    });
    onDestroy(() => { audioGeneration++; audioAnalysis?.releaseStream(originalAudioStream); });

    function watchVideoFrame(node, initial) {
        let previousStream;
        let previousEnabled;
        let cancel;
        function update({stream, enabled, original}) {
            if (stream === previousStream && enabled === previousEnabled) return;
            previousStream = stream;
            previousEnabled = enabled;
            cancel?.();
            videoReady = false;
            onVideoReady?.(false, original);
            if (stream && enabled) cancel = waitForDesktopFrame(node, () => {
                videoReady = true;
                onVideoReady?.(true, original);
            });
        }
        update(initial);
        return {update, destroy() { cancel?.(); }};
    }

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
            applyMute(node, muted || captureMuted || !!playback?.local, individuallyMuted);
            node.volume = volume;
            if (stream && connected) void play(node);
        }
        update(initial);
        return {update, destroy() { generation++; node.pause(); node.srcObject = null; }};
    }
</script>

<svelte:document on:fullscreenchange={() => fullscreen = document.fullscreenElement === tile}/>

<div class="desktop-tile" class:visualized class:focused class:thumbnail bind:this={tile} data-item-id={item.id} data-local={!!playback?.local}>
    <!-- svelte-ignore a11y_media_has_caption (Live desktop capture has no caption track.) -->
    <video bind:this={video} use:attachStream={{stream: renderedStream, connected}}
           use:watchVideoFrame={{stream: renderedStream, original: playback?.stream, enabled: videoRequested && connected && !blocked && !error && !playback?.error && !playback?.videoError}}
           controls={nativeControls && !inputDisabled && !visualized && !thumbnail} controlslist="nofullscreen" inert={inputDisabled || visualized || !nativeControls || thumbnail} playsinline aria-label={`Shared desktop: ${item.title}`}
           on:dblclick|preventDefault={toggleFullscreen}
           on:volumechange={rememberMute}
           on:loadeddata={() => loading = false} on:playing={() => { loading = false; error = ''; blocked = false; }}
           on:waiting={() => loading = true}
           on:error={() => error = 'This desktop could not be played. Retry playback.'}></video>
    <div class="desktop-heading">
        <span class="desktop-name" title={item.title}>{item.addedBy || item.title}{playback?.local ? ' (you)' : ''}</span>
        {#if focusAvailable}
            <button class="desktop-focus" type="button" disabled={inputDisabled}
                    aria-label={focused ? 'Show all desktops' : `Focus on ${item.addedBy || item.title}`}
                    title={focused ? 'Show all desktops' : `Focus on ${item.addedBy || item.title}`}
                    on:click={() => onFocus?.(focused ? null : item.id)}>
                <span>{focused ? 'Show all desktops' : thumbnail ? item.addedBy || item.title : `Focus on ${item.addedBy || item.title}`}</span>
            </button>
        {/if}
        {#if nativeControls && !thumbnail}<button class="icon-button desktop-fullscreen" type="button"
                aria-label={fullscreen ? 'Exit fullscreen' : `Fullscreen ${item.title}`} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen this desktop'}
                disabled={fullscreenPending || (inputDisabled && !fullscreen)} on:click={toggleFullscreen}>
            <Icon name="fullscreen" size={17}/>
        </button>{/if}
    </div>
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
    {:else if videoRequested && !videoReady}
        <div class="desktop-message desktop-video-loading" role="status"><span class="spinner" aria-hidden="true"></span>Loading desktop video…</div>
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
    .visualized .desktop-heading { display: none; }
    .focused { grid-column: 1 / -1; grid-row: 1; width: 100%; height: 100%; }
    .thumbnail { grid-row: 2; justify-self: center; width: auto; max-width: 100%; height: 100%; aspect-ratio: 16 / 9; }
    .desktop-heading {
        position: absolute;
        top: 7px;
        right: 8px;
        left: 8px;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 6px;
        pointer-events: none;
    }
    .desktop-heading button { pointer-events: auto; }
    .desktop-focus {
        min-width: 0;
        max-width: 65%;
        min-height: 30px;
        margin-left: auto;
        padding: 5px 8px;
        border: 1px solid #ffffff38;
        border-radius: 4px;
        background: #000b;
        color: #eee;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
    }
    .desktop-focus span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .desktop-focus:hover { background: #29232eee; border-color: var(--accent); }
    .desktop-focus:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .thumbnail .desktop-heading { inset: 0; }
    .thumbnail .desktop-name { display: none; }
    .thumbnail .desktop-focus {
        display: flex;
        align-items: flex-end;
        justify-content: center;
        width: 100%;
        max-width: none;
        height: 100%;
        min-height: 0;
        padding: 0;
        background: transparent;
        border-color: #ffffff28;
    }
    .thumbnail .desktop-focus span { max-width: 100%; padding: 4px 6px; background: #000c; border-radius: 3px; }
    .thumbnail .desktop-focus:hover { border-color: var(--accent); }
    .desktop-tile:fullscreen .desktop-focus { display: none; }
    video::-webkit-media-controls-fullscreen-button { display: none; }
    .desktop-tile:fullscreen { width: 100%; height: 100%; border-radius: 0; }
    .desktop-tile::backdrop { background: #050506; }
    .desktop-fullscreen {
        flex: 0 0 30px;
        margin-left: auto;
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
        min-width: 0;
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
    .desktop-video-loading {
        inset: 50% auto auto 50%;
        transform: translate(-50%, -50%);
        flex-direction: row;
        padding: 12px 16px;
        border: 1px solid #294232;
        border-radius: 7px;
        white-space: nowrap;
        pointer-events: none;
    }
</style>
