<script>
    import {onMount, onDestroy} from 'svelte';
    import Icon from './Icon.svelte';
    import ThumbnailControls from './ThumbnailControls.svelte';
    import {floatingThumbnail, controlsPosition} from '../lib/thumbnail.js';
    import {waitForDesktopFrame} from '../lib/desktop-video-ready.js';

    export let item;
    export let userId = null;
    export let playback = null;
    export let connected = false;
    export let volume = 0.8;
    export let ducked = false;
    export let muted = false;
    export let captureMuted = false;
    export let audioAnalysis;
    export let bassBoost = false;
    export let wacko = false;
    export let inputDisabled = false;
    export let visualized = false;
    export let nativeControls = true;
    export let focusAvailable = false;
    export let focused = false;
    export let unfocusLabel = 'Show all desktops';
    export let thumbnail = false;
    export let thumbnailIndex = 0;
    export let thumbnailCount = 1;
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
    let paused = true;
    let error = '';
    let generation = 0;
    let videoReady = false;
    let boostedStream = null;
    let originalAudioStream = null;
    let audioGeneration = 0;
    let hidden = false;
    // Apply ownership only as the initial preference so native unmute stays available.
    let individuallyMuted = !!userId && item.sharedBy === userId;
    let appliedMuted = false;
    const DUCK_GAIN = 0.2;
    let streamVolume = 1;
    let appliedVolume = volume;
    let thumbnailOpacity = 0.8;

    $: forcedMute = captureMuted || !!playback?.local;
    $: if (video) applyVolume(video, volume * streamVolume, ducked);
    $: streamMuted = muted || forcedMute || individuallyMuted;
    $: if (video) applyMute(video, muted || forcedMute, individuallyMuted);
    $: updateBassBoost(playback?.stream, bassBoost && connected && !forcedMute && !hidden, audioAnalysis, false, wacko && connected && !forcedMute && !hidden);
    $: renderedStream = boostedStream && boostedStream.original === playback?.stream ? boostedStream.stream : playback?.stream;

    function applyVolume(node, level, duck) {
        appliedVolume = Math.max(0, Math.min(1, level * (duck ? DUCK_GAIN : 1)));
        node.volume = appliedVolume;
    }

    function applyMute(node, masterMuted, streamMuted) {
        appliedMuted = masterMuted || streamMuted;
        node.muted = appliedMuted;
    }

    function rememberAudioPreferences() {
        if (!video) return;
        // Ignore our own events. External changes still retain a relative stream
        // preference, including across ducking and master-volume changes.
        if (video.volume !== appliedVolume) {
            const gain = volume * (ducked ? DUCK_GAIN : 1);
            if (gain > 0) streamVolume = Math.min(1, video.volume / gain);
            applyVolume(video, volume * streamVolume, ducked);
        }
        // Volume and mute writes queue the same event. Only a native mute change
        // that differs from our last applied value is an individual preference.
        if (video.muted === appliedMuted) return;
        if (muted || forcedMute) {
            video.muted = true;
            return;
        }
        individuallyMuted = video.muted;
        appliedMuted = video.muted;
    }

    function setStreamVolume(level) {
        streamVolume = Math.max(0, Math.min(1, level));
        individuallyMuted = false;
    }

    function scrollStreamVolume(event) {
        if (!event.deltaY || forcedMute) return;
        setStreamVolume(Math.round((streamVolume - Math.sign(event.deltaY) * 0.05) * 100) / 100);
    }

    function positionControls(node, initial) {
        const grid = node.closest('.desktop-grid');
        const container = node.closest('.desktop-tile');
        const viewport = node.closest('.video-viewport');
        let options = initial;
        let frame;
        function position() {
            const bounds = container.getBoundingClientRect();
            if (options.thumbnail) {
                node.style.removeProperty('left');
                node.style.removeProperty('bottom');
                return;
            }
            const obstacles = options.fullscreen ? [] : [...viewport.querySelectorAll('.floating-thumbnail')]
                .filter(element => element !== container && element.getClientRects().length)
                .map(element => element.getBoundingClientRect())
                .filter(rect => rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom)
                .map(rect => ({x: rect.left - bounds.left, y: rect.top - bounds.top, width: rect.width, height: rect.height}));
            const position = controlsPosition(container.clientWidth, container.clientHeight, node.offsetWidth, node.offsetHeight, obstacles);
            node.style.left = `${position.left}px`;
            node.style.bottom = `${position.bottom}px`;
        }
        function schedule() {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(position);
        }
        const observer = new ResizeObserver(schedule);
        observer.observe(grid);
        observer.observe(container);
        observer.observe(node);
        const mutations = new MutationObserver(records => {
            if (records.some(record => record.type === 'childList' ||
                record.target.matches('.floating-thumbnail, .desktop-tile, .video-thumbnail-controls'))) schedule();
        });
        mutations.observe(viewport, {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden']});
        schedule();
        return {
            update(next) { options = next; schedule(); },
            destroy() { observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame); },
        };
    }

    async function updateBassBoost(stream, enabled, analysis, gesture = false, warp = false) {
        const version = ++audioGeneration;
        if (stream !== originalAudioStream) {
            analysis?.releaseStream(originalAudioStream);
            originalAudioStream = stream;
            boostedStream = null;
        }
        if (!stream || !analysis) return;
        try {
            const processed = await analysis.boostStream(stream, enabled, gesture, warp);
            if (version === audioGeneration) boostedStream = {original: stream, stream: processed};
        } catch { /* Keep native desktop playback when Web Audio is unavailable. */ }
    }

    onMount(() => {
        const visibility = () => hidden = document.hidden;
        const gesture = () => void updateBassBoost(playback?.stream, bassBoost && connected && !forcedMute && !document.hidden, audioAnalysis, true, wacko && connected && !forcedMute && !document.hidden);
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
            applyVolume(node, volume * streamVolume, ducked);
            if (stream && connected) void play(node);
        }
        update(initial);
        return {update, destroy() { generation++; node.pause(); node.srcObject = null; }};
    }
</script>

<svelte:document on:fullscreenchange={() => fullscreen = document.fullscreenElement === tile}/>

<div class="desktop-tile" class:visualized class:focused class:thumbnail bind:this={tile} data-item-id={item.id} data-local={!!playback?.local}
     class:floating-thumbnail={thumbnail && !fullscreen}
     use:floatingThumbnail={{enabled: thumbnail && !fullscreen, index: thumbnailIndex, count: thumbnailCount, key: item.id}}
     inert={inputDisabled} style:--thumbnail-opacity={thumbnailOpacity}>
    <!-- svelte-ignore a11y_media_has_caption (Live desktop capture has no caption track.) -->
    <video bind:this={video} use:attachStream={{stream: renderedStream, connected}}
           use:watchVideoFrame={{stream: renderedStream, original: playback?.stream, enabled: videoRequested && connected && !blocked && !error && !playback?.error && !playback?.videoError}}
           controlslist="nofullscreen" inert={inputDisabled || visualized || !nativeControls || thumbnail} playsinline aria-label={`Shared desktop: ${item.title}`}
           on:dblclick|preventDefault={toggleFullscreen}
           on:volumechange={rememberAudioPreferences} on:play={() => paused = false} on:pause={() => paused = true}
           on:loadeddata={() => loading = false} on:playing={() => { loading = false; error = ''; blocked = false; }}
           on:waiting={() => loading = true}
           on:error={() => error = 'This desktop could not be played. Retry playback.'}></video>
    <div class="desktop-heading">
        <span class="desktop-name" title={item.title}>{item.addedBy || item.title}{playback?.local ? ' (you)' : ''}</span>
        {#if focusAvailable}
            <button class="desktop-focus" type="button" disabled={inputDisabled}
                    data-thumbnail-drag={thumbnail ? '' : undefined}
                    aria-label={focused ? unfocusLabel : `Focus on ${item.addedBy || item.title}`}
                    title={focused ? unfocusLabel : `Focus on ${item.addedBy || item.title}`}
                    on:click={() => onFocus?.(focused ? null : item.id)}>
                <span>{focused ? unfocusLabel : thumbnail ? item.addedBy || item.title : `Focus on ${item.addedBy || item.title}`}</span>
            </button>
        {/if}
        {#if nativeControls && !thumbnail}<button class="icon-button desktop-fullscreen" type="button"
                aria-label={fullscreen ? 'Exit fullscreen' : `Fullscreen ${item.title}`} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen this desktop'}
                disabled={fullscreenPending || (inputDisabled && !fullscreen)} on:click={toggleFullscreen}>
            <Icon name="fullscreen" size={17}/>
        </button>{/if}
    </div>
    {#if thumbnail}<ThumbnailControls title={item.title} bind:opacity={thumbnailOpacity}/>{/if}
    {#if nativeControls && !visualized}
        <div class="desktop-controls" use:positionControls={{fullscreen, thumbnail}}>
            <button class="icon-button" type="button" disabled={inputDisabled || !connected}
                    aria-label={`${paused ? 'Play' : 'Pause'} ${item.title} on this device`}
                    title={paused ? 'Play this stream' : 'Pause this stream'}
                    on:click={() => paused ? play() : video.pause()}>
                <Icon name={paused ? 'play' : 'pause'} size={16}/>
            </button>
            <button class="icon-button" type="button" disabled={inputDisabled || forcedMute || muted}
                    aria-label={`${streamMuted ? 'Unmute' : 'Mute'} ${item.title} on this device`}
                    title={muted ? 'Unmute the player to hear this stream' : 'Mute this stream'}
                    on:click={() => individuallyMuted = !individuallyMuted}>
                <Icon name={streamMuted || streamVolume === 0 ? 'mute' : 'volume'} size={16}/>
            </button>
            <input class="volume-range stream-volume-range" aria-label={`Volume for ${item.title}`}
                   type="range" min="0" max="1" step="0.01" value={streamVolume}
                   aria-valuetext={`${Math.round(streamVolume * 100)}% of player volume`}
                   title={`${Math.round(streamVolume * 100)}% of player volume`}
                   style={`--volume-progress: ${streamVolume * 100}%`} disabled={inputDisabled || forcedMute}
                   on:input={event => setStreamVolume(Number(event.currentTarget.value))}
                   on:wheel|nonpassive|preventDefault|stopPropagation={scrollStreamVolume}/>
        </div>
    {/if}
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
    .focused { flex-basis: 100%; width: 100%; height: 100%; }
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
    .thumbnail .desktop-heading { inset: 0 0 37px; }
    .thumbnail::after { content: ''; position: absolute; inset: 0; z-index: 6; pointer-events: none;
        border: 1px solid #ffffff28; border-radius: inherit; }
    .thumbnail:hover::after, .thumbnail:has(:focus-visible)::after { border-color: var(--accent); }
    .thumbnail .desktop-name { display: none; }
    .thumbnail .desktop-focus {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        width: 100%;
        max-width: none;
        height: 100%;
        min-height: 0;
        padding: 0;
        background: transparent;
        border: 0;
    }
    .thumbnail .desktop-focus span { max-width: calc(100% - 64px); padding: 4px 6px; background: #000c; border-radius: 3px; }
    .desktop-tile:fullscreen .desktop-focus { display: none; }
    video::-webkit-media-controls-fullscreen-button { display: none; }
    .desktop-tile:fullscreen { width: 100%; height: 100%; border-radius: 0; }
    .desktop-tile::backdrop { background: #050506; }
    .desktop-fullscreen {
        flex: 0 0 30px;
        width: 30px;
        height: 30px;
        background: #000b;
        color: #eee;
    }
    .desktop-controls {
        opacity: 0;
        pointer-events: none;
        position: absolute;
        left: 8px;
        bottom: 8px;
        z-index: 3;
        display: flex;
        align-items: center;
        gap: 6px;
        width: 200px;
        max-width: calc(100% - 16px);
        padding: 4px;
        border-radius: 5px;
        background: #000c;
        color: #eee;
    }
    .desktop-tile:hover .desktop-controls, .desktop-tile:has(:focus-visible) .desktop-controls {
        opacity: 1; pointer-events: auto;
    }
    .thumbnail .desktop-controls { left: 3px; bottom: 3px !important; max-width: calc(100% - 26px); gap: 1px; padding: 2px; }
    .thumbnail .desktop-controls .icon-button { flex-basis: 22px; width: 22px; height: 22px; }
    .thumbnail .desktop-controls .icon-button:first-child { display: none; }
    @media (hover: none) { .desktop-controls { opacity: 1; pointer-events: auto; } }
    .desktop-controls .icon-button { flex: 0 0 28px; width: 28px; height: 28px; }
    .stream-volume-range { display: block; flex: 1; min-width: 0; width: 96px; margin: 0; }
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
        margin-right: auto;
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
