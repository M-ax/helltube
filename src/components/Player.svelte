<script>
    import {onMount, onDestroy, tick} from 'svelte';
    import Hls from 'hls.js';
    import Icon from './Icon.svelte';
    import SeekJoystick from './SeekJoystick.svelte';
    import Reactions from './Reactions.svelte';
    import MetalPipeReaction from './MetalPipeReaction.svelte';
    import {PIPE_LIFETIME_MS} from '../lib/metal-pipe.js';
    import {createReactionAudio} from '../lib/reaction-audio.js';
    import {ballArena, BALL_WIDTH, BALL_HEIGHT} from '../../shared/beach-ball.js';
    import {targetPosition, driftCorrection, time} from '../lib/format.js';
    import {sourceLabels, sourceIcons} from '../../shared/media-source.js';
    import {sponsorPosition} from '../../shared/sponsorblock.js';
    import {delivery, isSameOriginUrl} from '../lib/delivery.js';
    import {createBufferHealth, isProxyLoadFailure} from '../lib/buffer-health.js';
    import {createVideoRenderer} from '../lib/video-renderer.js';
    import {createSeekPreview} from '../lib/seek-preview.js';

    export let room = null;
    export let connected = false;
    export let clockOffset = 0;
    export let rtt = null;
    export let overlay = null;
    export let reactions = {roomId: null, ball: null, serverTime: 0, events: []};
    export let onCommand;
    export let onAdd;
    export let preferences = {volume: 0.8, muted: false};
    export let preferenceKey = null;
    export let onPreferencesChange;
    let video;
    let canvas;
    let effectsCanvas;
    let renderer;
    let seekPreview;
    let seekCenter = null;
    let previewOffset = null;
    let previewPosition = null;
    let hitmarkerArmed = false;
    let hitmarkerTarget;
    let aim = {x: 0.5, y: 0.5};
    let activeReactions = [];
    let reactionRoom = null;
    let reactionAudio;
    let soundMuted = false;
    const seenReactions = new Set();
    const reactionTimers = new Set();
    const reactionEmoji = {heart: '❤️', laugh: '😂', clap: '👏'};
    let webglActive = false;
    let playerShell;
    let hls;
    let sourceKey = '';
    let sourceGeneration = 0;
    let sourceController;
    let mediaAccess = null;
    let bufferMonitor = null;
    let bufferReport = null;
    let metalItemId = null;
    let fallbackNotice = '';
    let initialAlign = true;
    let alignedRevision = -1;
    let playPending = false;
    let blocked = false;
    let localBuffering = false;
    let playerError = '';
    let volume = 0.8;
    let muted = false;
    let position = 0;
    let scrubPosition = 0;
    let scrubbing = false;
    let now = Date.now();
    let playing = false;
    let controlsVisible = true;
    let keyboardFocus = false;
    let activePointerCount = 0;
    let transportRowHeight = 43;
    let hideTimer;
    const CONTROLS_HIDE_DELAY = 3000;
    const VOLUME_CURVE = 100;

    $: item = room?.current;
    $: media = item?.media;
    $: duration = item?.duration;
    $: seekMax = Math.max(1, duration || media?.bufferedUntil || position);
    $: displayedPosition = scrubbing ? scrubPosition : position;
    $: progress = Math.min(100, displayedPosition / seekMax * 100);
    $: buffered = Math.min(100, Math.max(0, (media?.bufferedUntil || 0) / seekMax * 100));
    $: serverOverlay = overlay && overlay.expiresAt > now + clockOffset ? overlay.message : '';
    $: preparing = item && !media && item.status !== 'error';
    $: canAutoHide = !!media && connected && playing && !room?.playback.paused && !preparing
        && !localBuffering && !blocked && !playerError && item?.status !== 'error';
    $: holdControls = keyboardFocus || activePointerCount > 0 || scrubbing || seekCenter !== null || hitmarkerArmed;
    $: beachBall = connected && reactions.roomId === room?.id && !!reactions.ball;
    $: updateReactionRoom(connected ? room?.id : null);
    $: if (renderer) renderer.setBeachBallState(beachBall ? reactions.ball : null, (Date.now() + clockOffset - reactions.serverTime) / 1000);
    $: receiveReactions(reactions, connected, room?.id);
    $: scheduleControlsHide(canAutoHide, holdControls);
    $: applyPreferences(preferences, preferenceKey);
    $: volumePosition = Math.round(Math.log1p(volume * (VOLUME_CURVE - 1)) / Math.log(VOLUME_CURVE) * 100) / 100;
    $: if (video) attach(item?.id, media?.url, media?.baseTime);
    $: if (video) {
        video.volume = volume;
        video.muted = muted;
    }
    $: if (!connected && video) video.pause();
    $: if (!connected || playerError || item?.status === 'error') previewRelative(null);

    function applyPreferences(next, _key) {
        volume = typeof next?.volume === 'number' && Number.isFinite(next.volume)
            ? Math.max(0, Math.min(1, next.volume)) : 0.8;
        muted = typeof next?.muted === 'boolean' ? next.muted : false;
    }

    function setVolume(position) {
        // An audio taper gives the quiet end finer control, with exact silence at zero.
        const level = Math.max(0, Math.min(1, position));
        volume = (VOLUME_CURVE ** level - 1) / (VOLUME_CURVE - 1);
        muted = false;
        onPreferencesChange?.({volume, muted}, {key: preferenceKey, commit: false});
    }

    function changeVolume(event) {
        setVolume(Number(event.currentTarget.value));
    }

    function scrollVolume(event) {
        if (!event.deltaY) return;
        setVolume(Math.round((volumePosition - Math.sign(event.deltaY) * 0.05) * 100) / 100);
        revealControls();
    }

    function commitVolume() {
        onPreferencesChange?.({}, {key: preferenceKey, commit: true});
    }

    function toggleMute() {
        muted = !muted;
        onPreferencesChange?.({muted}, {key: preferenceKey, commit: true});
    }

    function scheduleControlsHide(eligible, held) {
        clearTimeout(hideTimer);
        if (!eligible || held) {
            controlsVisible = true;
            return;
        }
        hideTimer = setTimeout(() => controlsVisible = false, CONTROLS_HIDE_DELAY);
    }

    function revealControls() {
        controlsVisible = true;
        scheduleControlsHide(canAutoHide, holdControls);
    }

    function trackPlayerActivity(node) {
        const pointers = new Map();
        const listeners = [];
        let keyboardInput = true;
        let destroyed = false;

        function listen(target, type, handler, options = false) {
            target.addEventListener(type, handler, options);
            listeners.push(() => target.removeEventListener(type, handler, options));
        }

        function updateFocus() {
            queueMicrotask(() => {
                if (destroyed) return;
                const focused = document.activeElement;
                keyboardFocus = keyboardInput && !!focused?.closest('.player-controls')
                    && node.contains(focused) && focused.matches(':focus-visible');
            });
        }

        function releasePointer(event) {
            const target = pointers.get(event.pointerId);
            if (!target) return;
            pointers.delete(event.pointerId);
            activePointerCount = pointers.size;
            if (target.matches('.volume-range')) commitVolume();
            if (event.type === 'pointercancel' || event.type === 'lostpointercapture') scrubbing = false;
            revealControls();
        }

        function resetActivity() {
            if ([...pointers.values()].some(target => target.matches('.volume-range'))) commitVolume();
            for (const [id, target] of pointers) {
                if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
            }
            pointers.clear();
            activePointerCount = 0;
            scrubbing = false;
            keyboardFocus = false;
            revealControls();
        }

        listen(document, 'pointerdown', () => {
            keyboardInput = false;
            keyboardFocus = false;
        }, true);
        listen(document, 'keydown', () => keyboardInput = true, true);
        listen(node, 'keydown', () => {
            revealControls();
            updateFocus();
        }, true);
        listen(node, 'focusin', () => {
            revealControls();
            updateFocus();
        });
        listen(node, 'focusout', updateFocus);
        listen(node, 'pointermove', (event) => {
            if (event.pointerType !== 'touch' || pointers.has(event.pointerId)) revealControls();
        });
        listen(node, 'pointerdown', (event) => {
            const hidden = !controlsVisible;
            pointers.set(event.pointerId, event.target);
            activePointerCount = pointers.size;
            revealControls();
            if (hidden && !hitmarkerArmed && event.target.closest('.video-viewport')) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (event.target.matches('input[type="range"]')) {
                event.target.setPointerCapture(event.pointerId);
            }
        }, true);
        listen(node, 'gotpointercapture', (event) => {
            pointers.set(event.pointerId, event.target);
            activePointerCount = pointers.size;
            revealControls();
        }, true);
        listen(node, 'lostpointercapture', releasePointer, true);
        listen(window, 'pointerup', releasePointer);
        listen(window, 'pointercancel', releasePointer);
        listen(window, 'blur', resetActivity);
        listen(document, 'fullscreenchange', revealControls);

        return {
            destroy() {
                destroyed = true;
                clearTimeout(hideTimer);
                for (const remove of listeners) remove();
            },
        };
    }

    function cleanupSource() {
        sourceGeneration++;
        sourceController?.abort();
        sourceController = null;
        mediaAccess = null;
        bufferMonitor = null;
        bufferReport = null;
        playing = false;
        controlsVisible = true;
        seekCenter = null;
        previewOffset = null;
        seekPreview?.destroy();
        seekPreview = null;
        previewPosition = null;
        renderer?.setGhost(null);
        hls?.destroy();
        hls = null;
        video?.pause();
        if (video) {
            video.removeAttribute('src');
            video.load();
        }
        playPending = false;
    }

    async function attach(id, url, baseTime, accessOverride = null) {
        const key = `${id || ''}|${url || ''}|${baseTime || 0}`;
        if (sourceKey === key) return;
        cleanupSource();
        sourceKey = key;
        playerError = '';
        localBuffering = !!url;
        initialAlign = true;
        alignedRevision = -1;
        scrubbing = false;
        position = targetPosition(room, clockOffset);
        if (metalItemId !== id) {
            metalItemId = null;
            fallbackNotice = '';
        }
        if (!url) return;
        const generation = sourceGeneration;
        sourceController = new AbortController();
        let access;
        try {
            access = accessOverride || await delivery.resolveMediaAccess(url, {signal: sourceController.signal});
        } catch (error) {
            if (generation !== sourceGeneration) return;
            playerError = error.message || 'The video access URL could not be loaded. Please retry playback.';
            localBuffering = false;
            return;
        }
        if (generation !== sourceGeneration) return;
        if (metalItemId === id && access.fallbackUrl) {
            access = {url: access.fallbackUrl, fallbackUrl: null, route: 'metal'};
        }
        mediaAccess = access;
        bufferMonitor = createBufferHealth();
        const source = access.url;
        const target = Math.max(0, targetPosition(room, clockOffset) - (baseTime || 0));
        if (Hls.isSupported()) {
            const instance = new Hls({
                autoStartLoad: false,
                startPosition: target,
                maxBufferLength: 30,
                maxMaxBufferLength: 30,
                backBufferLength: 30,
                maxBufferSize: 30 * 1024 * 1024,
                liveSyncDurationCount: 3,
                maxLiveSyncPlaybackRate: 1,
                liveMaxLatencyDurationCount: Infinity,
                lowLatencyMode: false,
                xhrSetup: (xhr, url) => {
                    xhr.withCredentials = isSameOriginUrl(url);
                },
            });
            hls = instance;
            seekPreview = createSeekPreview(instance, Hls.Events, video, (frame, localTime) => {
                previewPosition = frame ? localTime + (baseTime || 0) : null;
                renderer?.setGhost(frame);
            });
            let recovered = false;
            instance.on(Hls.Events.MEDIA_ATTACHED, () => {
                if (generation === sourceGeneration) instance.loadSource(source);
            });
            instance.on(Hls.Events.MANIFEST_PARSED, () => {
                if (generation !== sourceGeneration) return;
                instance.startLoad(Math.max(0, targetPosition(room, clockOffset) - (baseTime || 0)));
            });
            instance.on(Hls.Events.FRAG_LOADED, (_event, data) => {
                if (generation === sourceGeneration) bufferMonitor?.fragmentLoaded(data.frag);
            });
            instance.on(Hls.Events.ERROR, (_event, data) => {
                if (generation !== sourceGeneration) return;
                if (isProxyLoadFailure(data, source) && switchToMetal('Cloudflare request failed')) return;
                if (!data.fatal) return;
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
                    recovered = true;
                    instance.recoverMediaError();
                } else {
                    playerError = data.type === Hls.ErrorTypes.NETWORK_ERROR
                        ? 'The video stream could not be loaded. Check your connection, then retry playback.'
                        : 'This browser could not decode the video stream. Retry, or try another browser.';
                    localBuffering = false;
                }
            });
            instance.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = source;
            video.load();
        } else {
            playerError = 'This browser does not support HLS playback. Try a current version of Chrome, Firefox, Edge, or Safari.';
            localBuffering = false;
        }
    }

    function switchToMetal(reason) {
        if (!connected || !mediaAccess?.fallbackUrl || mediaAccess.route !== 'cloudflare') return false;
        const access = {url: mediaAccess.fallbackUrl, fallbackUrl: null, route: 'metal'};
        metalItemId = item.id;
        fallbackNotice = `${reason}. Switched to metal for this video.`;
        sourceKey = '';
        // Reuse the already validated grant so recovery does not wait on another proxy request.
        void attach(item.id, media.url, media.baseTime, access);
        return true;
    }

    function reportBufferHealth() {
        if (!video || !media || !bufferMonitor) return;
        const absoluteTarget = targetPosition(room, clockOffset);
        const target = Math.max(0, absoluteTarget - (media.baseTime || 0));
        bufferReport = bufferMonitor.sample({ranges: video.buffered, currentTime: video.currentTime, target,
            serverAhead: media.bufferedUntil - absoluteTarget,
            remaining: Math.max(0, (duration || media.bufferedUntil) - absoluteTarget), complete: media.complete,
            active: connected && !playerError, paused: room.playback.paused, blocked,
            seeking: scrubbing || seekCenter !== null, buffering: localBuffering,
            playbackRate: video.playbackRate, playbackRevision: room.playback.revision});
        if (bufferReport.fallbackReason) switchToMetal(bufferReport.fallbackReason);
    }

    function nativePlaybackError() {
        if (hls || !media) return;
        if (video.error?.code === 2 && switchToMetal('Cloudflare request failed')) return;
        playerError = 'The video stream could not be played. Retry playback or use another browser.';
    }

    function tryPlay(userGesture = false) {
        if (!video || playPending || (blocked && !userGesture)) return;
        const generation = sourceGeneration;
        playPending = true;
        if (userGesture) {
            blocked = false;
            playerError = '';
        }
        const result = video.play();
        Promise.resolve(result).then(() => {
            if (generation !== sourceGeneration) return;
            blocked = false;
            if (!connected || room?.playback.paused) video.pause();
        }).catch((error) => {
            if (generation !== sourceGeneration) return;
            if (error.name === 'NotAllowedError') blocked = true;
            else if (error.name !== 'AbortError') playerError = 'Playback could not start in this browser. Retry playback below.';
        }).finally(() => {
            if (generation === sourceGeneration) playPending = false;
        });
    }

    function sync() {
        now = Date.now();
        if (connected) position = targetPosition(room, clockOffset, now);
        refreshPreview();
        if (!video || !media || !connected || playerError) {
            video?.pause();
            return;
        }
        const target = position - (media.baseTime || 0);
        if (target < 0 || video.readyState < 1) {
            localBuffering = true;
            video.pause();
            return;
        }
        const availableEnd = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.duration;
        if (Number.isFinite(availableEnd) && target > availableEnd + 0.1) {
            localBuffering = true;
            video.pause();
            return;
        }
        const correction = driftCorrection(target, video.currentTime);
        const actual = video.currentTime + (media.baseTime || 0);
        if (initialAlign || alignedRevision !== room.playback.revision || correction.seek !== null || sponsorPosition(item, actual) > actual) {
            try {
                video.currentTime = target;
                initialAlign = false;
                alignedRevision = room.playback.revision;
            } catch { /* Metadata may still be arriving. */
            }
        }
        video.playbackRate = room.playback.paused ? 1 : correction.rate;
        localBuffering = video.readyState < 3 && !room.playback.paused;
        if (room.playback.paused) video.pause();
        else if (video.paused && !blocked) tryPlay();
    }

    function control(action, value) {
        if (!connected) return;
        onCommand({type: 'control', action, ...(value !== undefined ? {position: value} : {})});
    }

    function seek(event) {
        const value = Number(event.currentTarget.value);
        scrubbing = false;
        if (Number.isFinite(value)) control('seek', value);
    }

    function seekRelative(seconds) {
        if (!connected || !media || item?.status === 'error') return;
        control('seek', Math.max(0, Math.min(seekMax, (seekCenter ?? targetPosition(room, clockOffset)) + seconds)));
    }

    function previewRelative(seconds) {
        if (seconds === null) seekCenter = null;
        else if (seekCenter === null) seekCenter = targetPosition(room, clockOffset);
        previewOffset = seconds || null;
        refreshPreview();
    }

    function refreshPreview() {
        if (previewOffset === null || !connected || !media || playerError || document.hidden) {
            seekPreview?.clear();
            return;
        }
        const target = Math.max(0, Math.min(seekMax, seekCenter + previewOffset));
        const frameTime = duration && target >= duration ? Math.max(0, duration - 1 / 30) : target;
        seekPreview?.request(frameTime - (media.baseTime || 0));
    }

    function updateReactionRoom(id) {
        if (reactionRoom === id) return;
        reactionRoom = id;
        hitmarkerArmed = false;
        activeReactions = [];
        seenReactions.clear();
        for (const timer of reactionTimers) clearTimeout(timer);
        reactionTimers.clear();
    }

    function receiveReactions(state, online, roomId) {
        if (!online || state.roomId !== roomId) return;
        for (const event of state.events) {
            if (seenReactions.has(event.id)) continue;
            seenReactions.add(event.id);
            const lifetime = event.kind === 'metalpipe' ? PIPE_LIFETIME_MS : event.kind === 'hitmarker' ? 450 : 1800;
            const age = Math.max(0, Date.now() + clockOffset - event.serverTime);
            if (age >= lifetime || document.hidden) continue;
            activeReactions = [...activeReactions.slice(-39), event];
            if (event.kind === 'hitmarker' && !soundMuted && !muted) reactionAudio?.play(volume);
            const timer = setTimeout(() => {
                activeReactions = activeReactions.filter(value => value.id !== event.id);
                reactionTimers.delete(timer);
            }, lifetime - age);
            reactionTimers.add(timer);
        }
        if (seenReactions.size > 200) {
            seenReactions.clear();
            for (const event of state.events) seenReactions.add(event.id);
        }
    }

    async function react(kind) {
        if (!connected) return;
        reactionAudio?.unlock();
        if (kind === 'hitmarker') {
            hitmarkerArmed = !hitmarkerArmed;
            aim = {x: 0.5, y: 0.5};
            await tick();
            hitmarkerTarget?.focus({preventScroll: true});
        } else if (kind === 'beachball') {
            onCommand({type: 'reaction', kind, enabled: !beachBall});
        } else {
            onCommand({type: 'reaction', kind, x: 0.2 + Math.random() * 0.6, y: 0.65});
        }
    }

    function pipeImpact() {
        if (connected && !soundMuted && !muted && !document.hidden) reactionAudio?.play(volume, 'metalpipe');
    }

    function placeHitmarker(event) {
        if (!connected || !hitmarkerArmed) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const point = event.detail === 0 ? aim : {
            x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
        };
        reactionAudio?.unlock();
        onCommand({type: 'reaction', kind: 'hitmarker', ...point});
        hitmarkerArmed = false;
        playerShell.focus({preventScroll: true});
    }

    function aimHitmarker(event) {
        const direction = {ArrowLeft: [-0.03, 0], ArrowRight: [0.03, 0], ArrowUp: [0, -0.03], ArrowDown: [0, 0.03]}[event.key];
        if (!direction) return;
        event.preventDefault();
        aim = {x: Math.max(0, Math.min(1, aim.x + direction[0])), y: Math.max(0, Math.min(1, aim.y + direction[1]))};
    }

    function trackReactionPointer(node) {
        let point = null;
        let lastSent = 0;
        let sent = false;
        let pointerRoom = null;
        function sendPoint() {
            if (pointerRoom !== room?.id) { point = null; sent = false; }
            if (!connected || !beachBall || !point) return;
            onCommand({type: 'reaction:pointer', ...point});
            lastSent = performance.now();
            sent = true;
        }
        function leave() {
            point = null;
            if (sent && connected) onCommand({type: 'reaction:pointer', x: null, y: null});
            sent = false;
        }
        function move(event) {
            if (!beachBall || event.target.closest('.player-controls, button:not(.hitmarker-target), input, a')) return leave();
            const rect = node.getBoundingClientRect();
            const inset = parseFloat(getComputedStyle(node).getPropertyValue('--controls-height')) || 71;
            const arena = ballArena(rect.width, rect.height, inset);
            const x = (event.clientX - rect.left - arena.x) / (BALL_WIDTH * arena.scale);
            const y = (event.clientY - rect.top - arena.y) / (BALL_HEIGHT * arena.scale);
            if (x < 0 || x > 1 || y < 0 || y > 1) return leave();
            point = {x, y};
            pointerRoom = room?.id;
            if (performance.now() - lastSent >= 60) sendPoint();
        }
        function release(event) { if (event.pointerType !== 'mouse') leave(); }
        const heartbeat = setInterval(() => { if (performance.now() - lastSent >= 500) sendPoint(); }, 500);
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerdown', move);
        node.addEventListener('pointerleave', leave);
        node.addEventListener('pointercancel', leave);
        window.addEventListener('pointerup', release);
        window.addEventListener('blur', leave);
        return {destroy() {
            clearInterval(heartbeat);
            node.removeEventListener('pointermove', move);
            node.removeEventListener('pointerdown', move);
            node.removeEventListener('pointerleave', leave);
            node.removeEventListener('pointercancel', leave);
            window.removeEventListener('pointerup', release);
            window.removeEventListener('blur', leave);
        }};
    }

    function retryPlayback() {
        sourceKey = '';
        attach(item?.id, media?.url, media?.baseTime);
    }

    async function fullscreen() {
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else if (playerShell.requestFullscreen) await playerShell.requestFullscreen();
            else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
            else playerError = 'Fullscreen is not available in this browser.';
        } catch {
            playerError = 'Fullscreen was blocked by your browser. You can continue watching here.';
        }
    }

    onMount(() => {
        reactionAudio = createReactionAudio();
        const unlockAudio = () => reactionAudio.unlock();
        const cancelReaction = event => { if (event.key === 'Escape') hitmarkerArmed = false; };
        document.addEventListener('pointerdown', unlockAudio);
        document.addEventListener('keydown', unlockAudio);
        document.addEventListener('keydown', cancelReaction);
        if (navigator.userActivation?.hasBeenActive) unlockAudio();
        renderer = createVideoRenderer(canvas, video, active => webglActive = active, effectsCanvas);
        const timer = setInterval(sync, 250);
        const healthTimer = setInterval(reportBufferHealth, 1000);
        document.addEventListener('visibilitychange', sync);
        return () => {
            document.removeEventListener('pointerdown', unlockAudio);
            document.removeEventListener('keydown', unlockAudio);
            document.removeEventListener('keydown', cancelReaction);
            reactionAudio.destroy();
            for (const timer of reactionTimers) clearTimeout(timer);
            renderer.destroy();
            renderer = null;
            clearInterval(timer);
            clearInterval(healthTimer);
            document.removeEventListener('visibilitychange', sync);
        };
    });
    onDestroy(cleanupSource);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus reveals the playback controls.) -->
<section class="player-shell" class:controls-hidden={!controlsVisible} bind:this={playerShell}
         use:trackPlayerActivity tabindex="0" aria-label="Synchronized room player"
         data-controls-visible={controlsVisible}>
    <div class="video-viewport" use:trackReactionPointer data-renderer={webglActive ? 'webgl' : 'native'}
         data-preview-time={previewPosition} data-beach-ball={beachBall}
         style={`--controls-height: ${transportRowHeight + 28}px`}>
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} playsinline preload="auto" crossorigin="anonymous" class:video-visible={!!media}
               class:webgl-source={webglActive}
               aria-label={item ? `Now playing: ${item.title}` : 'Room video player'} on:loadedmetadata={sync}
               on:canplay={sync} on:waiting={() => localBuffering = true}
               on:playing={() => { playing = true; localBuffering = false; }}
               on:pause={() => playing = false} on:ended={() => playing = false}
               on:error={nativePlaybackError}></video>
        <canvas bind:this={canvas} class="video-canvas" class:video-visible={!!media && webglActive} aria-hidden="true"></canvas>
        <canvas bind:this={effectsCanvas} class="player-effects" aria-hidden="true"></canvas>
        {#each activeReactions.filter(reaction => reaction.kind === 'metalpipe') as reaction (reaction.id)}
            <MetalPipeReaction {reaction} {clockOffset} onImpact={pipeImpact}/>
        {/each}
        <div class="reaction-overlay" aria-hidden="true">
            {#each activeReactions.filter(reaction => reaction.kind !== 'metalpipe') as reaction (reaction.id)}
                <span class="player-reaction" class:hitmarker={reaction.kind === 'hitmarker'}
                      data-reaction={reaction.kind} data-reaction-id={reaction.id}
                      style={`left: ${reaction.x * 100}%; top: ${reaction.y * 100}%`}>
                    {#if reaction.kind === 'hitmarker'}
                        <svg viewBox="0 0 40 40"><path d="M5 5l9 9m12 12 9 9M35 5l-9 9m-12 12-9 9"/></svg>
                    {:else}{reactionEmoji[reaction.kind]}{/if}
                </span>
            {/each}
        </div>
        {#if hitmarkerArmed}
            <button class="hitmarker-target" bind:this={hitmarkerTarget} type="button"
                    aria-label="Place hit marker on video. Arrow keys aim; Enter places; Escape cancels."
                    on:click={placeHitmarker} on:keydown={aimHitmarker}>
                <span class="hitmarker-aim" style={`left: ${aim.x * 100}%; top: ${aim.y * 100}%`}>+</span>
            </button>
        {/if}
        {#if previewPosition !== null}
            <div class="seek-preview-label">Seek preview · {time(previewPosition)}</div>
        {/if}
        <div class="screen-topline"><span class="screen-brand"><Icon name="flame" size={16}/>HELLTUBE CINEMA</span><span
                class="screen-tag">{!item ? 'THE SCREEN IS YOURS' : !connected ? 'CONNECTION LOST' : room.playback.paused ? 'PAUSED TOGETHER' : 'WATCHING TOGETHER'}</span>
        </div>
        {#if !item}
            <div class="screen-empty"><span class="cinema-orbit"><Icon name="play" size={36} stroke={1.4}/></span>
                <p class="eyebrow">LIGHTS DOWN. POSSIBILITIES UP.</p>
                <h2>What’s the first <em>watch?</em></h2>
                <p>Add a YouTube, Twitch VOD, or media link, or a video from your device.<br/>Good things are better with company.</p>
                <button class="button primary" disabled={!connected} on:click={onAdd}>
                    <Icon name="plus" size={17}/>
                    Add something good
                </button>
            </div>
            <div class="screen-corner corner-left"></div>
            <div class="screen-corner corner-right"></div>
        {:else if item.status === 'error' || playerError}
            <div class="screen-message error-screen" role="alert"><span class="screen-message-icon"><Icon name="warning"
                                                                                                          size={28}/></span>
                <h3>This watch hit a snag.</h3>
                <p>{item.error || playerError}</p>
                <div class="button-row">
                    {#if playerError && media}
                        <button class="button secondary small" on:click={retryPlayback}>
                            <Icon name="refresh" size={16}/>
                            Retry playback
                        </button>
                    {/if}
                    <button class="button primary small" disabled={!connected} on:click={() => control('skip')}>Skip
                        this video
                        <Icon name="next" size={16}/>
                    </button>
                </div>
            </div>
        {:else if !connected}
            <div class="screen-message" role="status">
                <Icon name="offline" size={30}/>
                <h3>Holding your place.</h3>
                <p>Reconnecting to the room. Playback is paused on this device until a fresh state arrives.</p></div>
        {:else if preparing}
            <div class="screen-message" role="status"><span class="spinner large-spinner"></span>
                <h3>{item.status === 'uploading' ? 'Making room for your video.' : 'Getting the screen ready.'}</h3>
                <p>{item.status === 'uploading' ? 'Receiving and preparing the file. Playback begins as soon as the server has playable media.' : 'The server is preparing this video for everyone. Hang tight.'}</p>
                {#if item.kind === 'upload'}<span class="container-note">Some MP4/MOV and other containers keep their index at the end and need the complete upload before playback can begin.</span>{/if}
            </div>
        {:else if blocked}
            <div class="screen-message"><span class="screen-message-icon"><Icon name="volume" size={28}/></span>
                <h3>Your browser needs a little nudge.</h3>
                <p>Enable video and sound on this device. Everyone else keeps watching, uninterrupted.</p>
                <button class="button primary" on:click={() => tryPlay(true)}>
                    <Icon name="play" size={18}/>
                    Enable playback
                </button>
            </div>
        {:else if localBuffering}
            <div class="buffering-indicator" role="status"><span class="spinner"></span>Buffering your view…</div>
        {/if}
        {#if serverOverlay}
            <div class="server-overlay" role="status" aria-live="polite">
                <Icon name="info" size={20}/>
                <span>{serverOverlay}</span></div>
        {/if}
        <div class="player-controls transport" role="group" aria-label="Playback controls">
            {#if canAutoHide}
                <div class="controls-backdrop" aria-hidden="true">
                    <span class="controls-blur"></span><span class="controls-blur"></span>
                    <span class="controls-blur"></span><span class="controls-blur"></span>
                </div>
            {/if}
            <div class="seek-track" style={`--progress: ${progress}%; --buffered: ${buffered}%`}>
                <input type="range" min="0" max={seekMax} step="0.1" value={displayedPosition}
                       disabled={!connected || !media} aria-label="Seek shared video"
                       aria-valuetext={`${time(displayedPosition)}${duration ? ` of ${time(duration)}` : ''}`}
                       on:input={(event) => { scrubbing = true; scrubPosition = Number(event.currentTarget.value); }}
                       on:change={seek} on:blur={() => scrubbing = false}/>
            </div>
            <div class="transport-row" bind:clientHeight={transportRowHeight}>
                <div class="shared-controls">
                    <button class="icon-button" title="Play previous video for everyone"
                            aria-label="Play previous video for everyone" disabled={!connected || !room?.history?.length}
                            on:click={() => control('previous')}>
                        <Icon name="previous" size={19}/>
                    </button>
                    <button class="play-button"
                            aria-label={room?.playback.paused ? 'Play for everyone' : 'Pause for everyone'}
                            disabled={!connected || !media || item?.status === 'error'}
                            on:click={() => control(room.playback.paused ? 'play' : 'pause')}>
                        <Icon name={room?.playback.paused || !item ? 'play' : 'pause'} size={21}/>
                    </button>
                    <button class="icon-button" title="Skip video for everyone" aria-label="Skip video for everyone"
                            disabled={!connected || !item} on:click={() => control('skip')}>
                        <Icon name="next" size={19}/>
                    </button>
                    <span class="time-display">{time(displayedPosition)}<span> / {time(duration)}</span></span>
                </div>
                <div class="relative-seek-control">
                    {#key `${room?.id}|${sourceKey}`}
                        <SeekJoystick disabled={!connected || !media || !!playerError || item?.status === 'error'}
                                      onSeek={seekRelative} onPreview={previewRelative}/>
                    {/key}
                </div>
                <div class="local-controls"><span class="shared-label"><Icon name="users" size={13}/>Shared controls</span>
                    <button class="icon-button" aria-label={muted ? 'Unmute on this device' : 'Mute on this device'}
                            title="Volume is just for you" on:click={toggleMute}>
                        <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={19}/>
                    </button>
                    <input class="volume-range" aria-label="Volume on this device" type="range" min="0" max="1" step="0.01"
                           value={volumePosition} aria-valuetext={`${Math.round(volumePosition * 100)}%`}
                           style={`--volume-progress: ${volumePosition * 100}%`}
                           on:input={changeVolume} on:change={commitVolume} on:blur={commitVolume}
                           on:wheel|nonpassive|preventDefault|stopPropagation={scrollVolume}/>
                    <button class="icon-button" aria-label="Toggle fullscreen" on:click={fullscreen}>
                        <Icon name="fullscreen" size={18}/>
                    </button>
                </div>
            </div>
        </div>
    </div>
</section>
<Reactions {connected} {beachBall} armed={hitmarkerArmed} {soundMuted} onReact={react}
           onSoundToggle={() => { soundMuted = !soundMuted; reactionAudio?.unlock(); }}/>
<div class="now-playing">
    <div class="now-playing-title"><p class="eyebrow">{item ? 'NOW ON SCREEN' : 'UP NEXT: YOUR PICK'}</p>
        <h2>{item?.title || 'A little less scrolling. A little more watching.'}</h2>
        <div class="media-meta">
            {#if item}<span><Icon name={sourceIcons[item.kind] || 'file'}
                                  size={15}/>{sourceLabels[item.kind] || 'Video'}</span>
                {#if duration}<span>{time(duration)}</span>{/if}<span
                        class:status-error={item.status === 'error'}>{item.status}</span>{:else}<span>Everyone in the room can add videos and control playback.</span>{/if}
            {#if item?.kind === 'youtube' && item.sponsorSegments?.length}
                <a href="https://sponsor.ajay.app/" target="_blank" rel="noreferrer" title="Sponsor segments are skipped for everyone in the room">SponsorBlock</a>
            {/if}
        </div>
    </div>
    <span class="sync-badge" class:disconnected={!connected}
          title={connected ? `Clock estimated using WebSocket round-trip midpoint${rtt !== null ? ` · RTT ${Math.round(rtt)} ms` : ''}` : 'Waiting for fresh room state'}><Icon
            name={connected ? 'wifi' : 'offline'} size={15}/>{connected ? 'Room synced' : 'Not connected'}
        {#if connected && rtt !== null}<span>{Math.round(rtt)} ms</span>{/if}</span></div>
{#if media && mediaAccess}
    <div class="playback-health" aria-label="Playback buffer health" data-delivery={mediaAccess.route}
         data-buffer-status={bufferReport?.status || 'Loading'}>
        <span class="buffer-health-state" class:status-error={bufferReport?.status === 'Buffering' || bufferReport?.status === 'Low buffer'}>
            {bufferReport?.status || 'Loading video'}
        </span>
        <span>{mediaAccess.route === 'cloudflare' ? 'Cloudflare' : mediaAccess.route === 'metal' ? 'Metal' : 'Server'}</span>
        {#if bufferReport}
            <span>{bufferReport.seconds.toFixed(1)}s buffered</span>
            <span title="Video prepared on the server ahead of the room position">{bufferReport.serverAhead.toFixed(1)}s ready at source</span>
            {#if bufferReport.mbps !== null}
                <span title="Recent segment download speed, including request latency">{bufferReport.mbps.toFixed(1)} Mbps · {bufferReport.downloadRate.toFixed(1)}× playback</span>
            {/if}
        {/if}
    </div>
{/if}
{#if fallbackNotice && media}
    <p class="delivery-notice" role="status">{fallbackNotice}</p>
{/if}
{#if item?.kind === 'upload' && media && !media.complete}
    <p class="inline-note">
        <Icon name="info" size={16}/>
        This video is still being prepared. {time(media.bufferedUntil)} is ready; seeking further may need more
        preparation or the remaining upload.
    </p>
{/if}
