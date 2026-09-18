<script>
    import {onMount, onDestroy, tick} from 'svelte';
    import Hls from 'hls.js';
    import Icon from './Icon.svelte';
    import CrtScreen from './CrtScreen.svelte';
    import SeekJoystick from './SeekJoystick.svelte';
    import QualitySelect from './QualitySelect.svelte';
    import DesktopStats from './DesktopStats.svelte';
    import Reactions from './Reactions.svelte';
    import PointingFingers from './PointingFingers.svelte';
    import {trackReactionPointer} from '../lib/reaction-pointer.js';
    import MetalPipeReaction from './MetalPipeReaction.svelte';
    import FlashbangReaction from './FlashbangReaction.svelte';
    import BidenReaction from './BidenReaction.svelte';
    import {BIDEN_LIFETIME_MS} from '../lib/biden.js';
    import {PIPE_LIFETIME_MS} from '../lib/metal-pipe.js';
    import {FLASH_LIFETIME_MS} from '../lib/flashbang.js';
    import {createReactionAudio} from '../lib/reaction-audio.js';
    import {targetPosition, driftCorrection, time, bufferDuration} from '../lib/format.js';
    import {sourceLabels, sourceIcons} from '../../shared/media-source.js';
    import {sponsorPosition} from '../../shared/sponsorblock.js';
    import {delivery, isSameOriginUrl} from '../lib/delivery.js';
    import {createBufferHealth, isProxyLoadFailure} from '../lib/buffer-health.js';
    import {createVideoRenderer} from '../lib/video-renderer.js';
    import {createSeekPreview} from '../lib/seek-preview.js';
    import {availableQualities, qualityReady, selectQuality} from '../lib/media-quality.js';

    export let username = 'guest';
    export let room = null;
    export let connected = false;
    export let clockOffset = 0;
    export let rtt = null;
    export let overlay = null;
    export let reactions = {roomId: null, ball: null, serverTime: 0, events: []};
    export let onCommand;
    export let onAdd;
    export let preparation = null;
    export let preferences = {volume: 0.8, muted: false};
    export let preferenceKey = null;
    export let onPreferencesChange;
    export let captureMuted = false;
    export let desktopPlayback = {itemId: null, stream: null, error: '', local: false};
    export let onRetryDesktop;
    let video;
    let canvas;
    let effectsCanvas;
    let renderer;
    let seekPreview;
    let seekCenter = null;
    let previewOffset = null;
    let previewPosition = null;
    let hitmarkerArmed = false;
    let fingerArmed = false;
    let localFinger = null;
    let hitmarkerTarget;
    let aim = {x: 0.5, y: 0.5};
    let activeReactions = [];
    let reactionRoom = null;
    let reactionAudio;
    let reactionsEnabled = true;
    let soundMuted = false;
    const seenReactions = new Set();
    const reactionTimers = new Set();
    const reactionEmoji = {heart: '❤️', laugh: '😂', clap: '👏'};
    let webglEffectsActive = false;
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
    let qualityPreference = 'original';
    let qualityFallbackItemId = null;
    let qualityNotice = '';
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
    let hasFrame = false;
    let controlsVisible = true;
    let keyboardFocus = false;
    let activePointerCount = 0;
    let transportRowHeight = 43;
    let hideTimer;
    const CONTROLS_HIDE_DELAY = 3000;
    const VOLUME_CURVE = 100;

    $: item = room?.current;
    $: live = item?.kind === 'desktop';
    $: qualities = availableQualities(item?.media);
    $: media = selectQuality(item?.media, qualityPreference, position, {standardOnly: qualityFallbackItemId === item?.id});
    $: crtVisible = (!media && !live) || (!hasFrame && connected && !blocked && !playerError && item?.status !== 'error');
    $: if (renderer) renderer.setCrtActive(crtVisible);
    $: duration = item?.duration;
    $: seekMax = Math.max(1, duration || media?.bufferedUntil || position);
    $: displayedPosition = scrubbing ? scrubPosition : position;
    $: progress = Math.min(100, displayedPosition / seekMax * 100);
    $: buffered = Math.min(100, Math.max(0, (media?.bufferedUntil || 0) / seekMax * 100));
    $: serverOverlay = overlay && overlay.expiresAt > now + clockOffset ? overlay.message : '';
    $: preparing = item && !media && !live && item.status !== 'error';
    $: canAutoHide = (!!media || live) && connected && playing && !room?.playback.paused && !preparing
        && !localBuffering && !blocked && !playerError && item?.status !== 'error';
    $: holdControls = keyboardFocus || activePointerCount > 0 || scrubbing || seekCenter !== null || hitmarkerArmed;
    $: beachBall = reactionsEnabled && connected && reactions.roomId === room?.id && !!reactions.ball;
    $: updateReactionRoom(connected ? room?.id : null);
    $: if (renderer) renderer.setBeachBallState(beachBall ? reactions.ball : null, (Date.now() + clockOffset - reactions.serverTime) / 1000);
    $: receiveReactions(reactions, connected, room?.id, reactionsEnabled);
    $: if (soundMuted || muted || captureMuted || volume <= 0) reactionAudio?.stop();
    $: scheduleControlsHide(canAutoHide, holdControls);
    $: applyPreferences(preferences, preferenceKey);
    $: volumePosition = Math.round(Math.log1p(volume * (VOLUME_CURVE - 1)) / Math.log(VOLUME_CURVE) * 100) / 100;
    $: if (video) attach(item?.id, media?.url, media?.baseTime, null, live ? desktopPlayback : null);
    $: if (video) {
        video.volume = volume;
        video.muted = muted || captureMuted || (live && desktopPlayback.local);
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

    function changeQuality(id) {
        qualityFallbackItemId = null;
        qualityNotice = '';
        qualityPreference = id;
        revealControls();
    }

    function useStandardQuality(reason = 'Original quality could not be played') {
        if (media?.id !== 'original') return false;
        qualityFallbackItemId = item.id;
        qualityNotice = reason;
        return qualities.some(quality => quality.id === 'standard' && qualityReady(quality, targetPosition(room, clockOffset)));
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
        let fullscreenClickAllowed = false;

        function listen(target, type, handler, options = false) {
            target.addEventListener(type, handler, options);
            listeners.push(() => target.removeEventListener(type, handler, options));
        }

        function canToggleFullscreen(event) {
            return !hitmarkerArmed && !fingerArmed && !beachBall
                && event.target.closest('.video-viewport')
                && !event.target.closest('.player-controls, button, input, a, select, textarea, [role="button"]');
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
        listen(node, 'click', (event) => {
            // Remember the first click before placing a hit marker clears its selection.
            if (event.detail === 1) fullscreenClickAllowed = canToggleFullscreen(event);
        }, true);
        listen(node, 'dblclick', (event) => {
            if (!fullscreenClickAllowed || !canToggleFullscreen(event)) return;
            event.preventDefault();
            fullscreen();
        });
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
        hasFrame = false;
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
            video.srcObject = null;
            video.removeAttribute('src');
            video.load();
        }
        playPending = false;
    }

    async function attach(id, url, baseTime, accessOverride = null, desktop = null) {
        const key = `${id || ''}|${url || ''}|${baseTime || 0}|${desktop ? 'desktop' : 'hls'}`;
        const stream = desktop && desktop.itemId === id ? desktop.stream : null;
        if (sourceKey === key && (!desktop || video.srcObject === stream)) {
            if (desktop) playerError = desktop.error || '';
            return;
        }
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
        if (qualityFallbackItemId !== id) {
            qualityFallbackItemId = null;
            qualityNotice = '';
        }
        if (desktop) {
            playerError = desktop.error || '';
            localBuffering = !stream;
            video.srcObject = stream;
            video.playbackRate = 1;
            if (stream) tryPlay();
            return;
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
                if (useStandardQuality()) return;
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
        const standard = media.id === 'original' ? qualities.find(quality => quality.id === 'standard' &&
            quality.baseTime <= absoluteTarget) : null;
        bufferReport = bufferMonitor.sample({ranges: video.buffered, currentTime: video.currentTime, target,
            serverAhead: media.bufferedUntil - absoluteTarget,
            remaining: Math.max(0, (duration || media.bufferedUntil) - absoluteTarget), complete: media.complete,
            active: connected && !playerError, paused: room.playback.paused, blocked,
            seeking: scrubbing || seekCenter !== null, buffering: localBuffering,
            playbackRate: video.playbackRate, playbackRevision: room.playback.revision,
            alternativeAhead: standard ? standard.bufferedUntil - absoluteTarget : 0,
            alternativeComplete: standard?.complete || false});
        if (bufferReport.qualityFallbackReason && useStandardQuality(bufferReport.qualityFallbackReason)) return;
        if (bufferReport.fallbackReason) switchToMetal(bufferReport.fallbackReason);
    }

    function nativePlaybackError() {
        if (hls || (!media && !live)) return;
        if (video.error?.code === 2 && switchToMetal('Cloudflare request failed')) return;
        if (useStandardQuality()) return;
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
            if (!connected || (!live && room?.playback.paused)) video.pause();
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
        if (live) {
            if (!video || !connected || playerError || !video.srcObject) { video?.pause(); return; }
            video.playbackRate = 1;
            localBuffering = video.readyState < 2;
            if (video.paused && !blocked) tryPlay();
            return;
        }
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
        if (!connected || (live && action !== 'skip')) return;
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
        clearActiveReactions();
        seenReactions.clear();
    }

    function clearActiveReactions() {
        hitmarkerArmed = false;
        fingerArmed = false;
        localFinger = null;
        activeReactions = [];
        reactionAudio?.stop();
        for (const timer of reactionTimers) clearTimeout(timer);
        reactionTimers.clear();
    }

    function toggleReactions() {
        reactionsEnabled = !reactionsEnabled;
        if (!reactionsEnabled) {
            clearActiveReactions();
            reactionAudio?.stop();
        }
    }

    function receiveReactions(state, online, roomId, enabled) {
        if (!online || state.roomId !== roomId) return;
        for (const event of state.events) {
            if (seenReactions.has(event.id)) continue;
            seenReactions.add(event.id);
            if (!enabled) continue;
            const lifetime = event.kind === 'biden' ? BIDEN_LIFETIME_MS : event.kind === 'flashbang' ? FLASH_LIFETIME_MS
                : event.kind === 'metalpipe' ? PIPE_LIFETIME_MS : event.kind === 'hitmarker' ? 450 : 1800;
            const age = Math.max(0, Date.now() + clockOffset - event.serverTime);
            if (age >= lifetime || document.hidden) continue;
            if (event.kind === 'fingertap') {
                if (event.clientId !== state.clientId && age < 200) reactionSound('fingertap');
                continue;
            }
            if (event.kind === 'fingerstatic') {
                if (age < 200) reactionSound('fingerstatic', event.strength);
                continue;
            }
            activeReactions = [...activeReactions.slice(-39), event];
            if (event.kind === 'hitmarker' && !soundMuted && !muted && !captureMuted) reactionAudio?.play(volume);
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
        if (!connected || !reactionsEnabled) return;
        reactionAudio?.unlock();
        if (kind === 'finger') {
            fingerArmed = !fingerArmed;
            hitmarkerArmed = false;
        } else if (kind === 'hitmarker') {
            fingerArmed = false;
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
        if (reactionsEnabled && connected && !soundMuted && !muted && !captureMuted && !document.hidden) reactionAudio?.play(volume, 'metalpipe');
    }

    function reactionSound(kind, level = 1) {
        if (reactionsEnabled && connected && !soundMuted && !muted && !captureMuted && !document.hidden) {
            return reactionAudio?.play(volume * level, kind);
        }
    }

    function fingerSlide(id, speed) {
        const level = reactionsEnabled && connected && !soundMuted && !muted && !captureMuted && !document.hidden ? volume : 0;
        reactionAudio?.slide(id, level, speed);
    }

    function fingerTap() { reactionAudio?.unlock(); reactionSound('fingertap'); }
    function setLocalFinger(finger) { localFinger = finger; }

    function placeHitmarker(event) {
        if (!connected || !reactionsEnabled || !hitmarkerArmed) return;
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

    function retryPlayback() {
        if (live) { onRetryDesktop?.(); return; }
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
        const cancelReaction = event => { if (event.key === 'Escape') { hitmarkerArmed = false; fingerArmed = false; } };
        document.addEventListener('pointerdown', unlockAudio);
        document.addEventListener('keydown', unlockAudio);
        document.addEventListener('keydown', cancelReaction);
        if (navigator.userActivation?.hasBeenActive) unlockAudio();
        renderer = createVideoRenderer(canvas, video, active => webglEffectsActive = active, effectsCanvas);
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
    <div class="video-viewport" class:finger-armed={fingerArmed}
         use:trackReactionPointer={{beachBall, fingerEnabled: fingerArmed, enabled: reactionsEnabled, connected,
             roomId: room?.id, onCommand, onFinger: setLocalFinger, onTap: fingerTap}}
         data-renderer="native" data-effects-renderer={webglEffectsActive ? 'webgl' : '2d'}
         data-preview-time={previewPosition} data-beach-ball={beachBall}
         style={`--controls-height: ${transportRowHeight + 28}px`}>
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} playsinline preload="auto" crossorigin="anonymous" class:video-visible={!!media || live}
               aria-label={item ? `Now playing: ${item.title}` : 'Room video player'} on:loadedmetadata={sync}
               on:canplay={sync} on:loadeddata={() => hasFrame = true} on:waiting={() => localBuffering = true}
               on:playing={() => { playing = true; localBuffering = false; }}
               on:pause={() => playing = false} on:ended={() => playing = false}
               on:error={nativePlaybackError}></video>
        <canvas bind:this={canvas} class="video-canvas" class:crt-flames={crtVisible}
                class:video-visible={webglEffectsActive && (crtVisible || !!media || live)} aria-hidden="true"></canvas>
        <canvas bind:this={effectsCanvas} class="player-effects" aria-hidden="true"></canvas>
        {#if reactionsEnabled && connected && reactions.roomId === room?.id && (fingerArmed || reactions.fingers?.length)}
            <PointingFingers fingers={reactions.fingers || []} local={localFinger} clientId={reactions.clientId}
                             {clockOffset} onSlide={fingerSlide}/>
        {/if}
        {#each activeReactions.filter(reaction => reaction.kind === 'metalpipe') as reaction (reaction.id)}
            <MetalPipeReaction {reaction} {clockOffset} onImpact={pipeImpact}/>
        {/each}
        {#each activeReactions.filter(reaction => reaction.kind === 'flashbang') as reaction (reaction.id)}
            <FlashbangReaction {reaction} {clockOffset} onSound={reactionSound}/>
        {/each}
        {#each activeReactions.filter(reaction => reaction.kind === 'biden') as reaction (reaction.id)}
            <BidenReaction {reaction} {clockOffset} onSound={reactionSound}/>
        {/each}
        <div class="reaction-overlay" aria-hidden="true">
            {#each activeReactions.filter(reaction => !['metalpipe', 'flashbang', 'biden'].includes(reaction.kind)) as reaction (reaction.id)}
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
        {#if crtVisible}
            <CrtScreen {username} {item} {connected} {onAdd} onSkip={() => control('skip')}
                       pending={item ? null : room?.preparation || (preparation?.roomId === room?.id ? preparation : null)}/>
        {:else if item.status === 'error' || playerError}
            <div class="screen-message error-screen" role="alert"><span class="screen-message-icon"><Icon name="warning"
                                                                                                          size={28}/></span>
                <h3>This watch hit a snag.</h3>
                <p>{item.error || playerError}</p>
                <div class="button-row">
                    {#if playerError && (media || live)}
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
                       disabled={!connected || !media || live} aria-label="Seek shared video"
                       aria-valuetext={`${time(displayedPosition)}${duration ? ` of ${time(duration)}` : ''}`}
                       on:input={(event) => { scrubbing = true; scrubPosition = Number(event.currentTarget.value); }}
                       on:change={seek} on:blur={() => scrubbing = false}/>
            </div>
            <div class="transport-row" bind:clientHeight={transportRowHeight}>
                <div class="shared-controls">
                    <button class="icon-button" title="Play previous video for everyone"
                            aria-label="Play previous video for everyone" disabled={!connected || !room?.history?.length || live}
                            on:click={() => control('previous')}>
                        <Icon name="previous" size={19}/>
                    </button>
                    <button class="play-button"
                            aria-label={room?.playback.paused ? 'Play for everyone' : 'Pause for everyone'}
                            disabled={!connected || !media || item?.status === 'error' || live}
                            on:click={() => control(room.playback.paused ? 'play' : 'pause')}>
                        <Icon name={room?.playback.paused || !item ? 'play' : 'pause'} size={21}/>
                    </button>
                    <button class="icon-button" title="Skip video for everyone" aria-label="Skip video for everyone"
                            disabled={!connected || !item} on:click={() => control('skip')}>
                        <Icon name="next" size={19}/>
                    </button>
                    <span class="time-display">{#if live}LIVE{:else}{time(displayedPosition)}<span> / {time(duration)}</span>{/if}</span>
                </div>
                <div class="relative-seek-control">
                    {#key `${room?.id}|${sourceKey}`}
                        <SeekJoystick disabled={!connected || !media || !!playerError || item?.status === 'error' || live}
                                      onSeek={seekRelative} onPreview={previewRelative}/>
                    {/key}
                </div>
                <div class="local-controls"><span class="shared-label"><Icon name="users" size={13}/>Shared controls</span>
                    {#if media}
                        {#key `${room?.id}|${item?.id}`}
                            <QualitySelect {qualities} value={media.id || 'standard'} {position} {controlsVisible}
                                           onChange={changeQuality}/>
                        {/key}
                    {/if}
                    <button class="icon-button" aria-label={captureMuted ? 'Playback muted while sharing' : muted ? 'Unmute on this device' : 'Mute on this device'}
                            disabled={captureMuted} title="Volume is just for you" on:click={toggleMute}>
                        <Icon name={muted || captureMuted || volume === 0 ? 'mute' : 'volume'} size={19}/>
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
<Reactions {connected} {beachBall} {fingerArmed} armed={hitmarkerArmed} enabled={reactionsEnabled} {soundMuted} onReact={react}
           onEnabledToggle={toggleReactions}
           onSoundToggle={() => { soundMuted = !soundMuted; reactionAudio?.unlock(); }}/>
<div class="now-playing">
    {#if captureMuted}<p class="field-help" role="status">Your player is muted while sharing to prevent audio feedback. Viewers receive your shared audio.</p>{/if}
    <div class="now-playing-title"><p class="eyebrow">{item ? 'NOW ON SCREEN' : 'UP NEXT: YOUR PICK'}</p>
        <div class="now-playing-heading">
            <h2>{item?.title || 'A little less scrolling. A little more watching.'}</h2>
            {#if item?.hasOriginalStream}
                <a class="icon-button bordered"
                   href={`/api/rooms/${encodeURIComponent(room.id)}/items/${encodeURIComponent(item.id)}/original`}
                   target="_blank" rel="noopener noreferrer"
                   aria-label="Open original stream" title="Open original stream in a new tab">
                    <Icon name="external" size={16}/>
                </a>
            {/if}
        </div>
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
{#if live}
    <DesktopStats playback={desktopPlayback.itemId === item.id ? desktopPlayback : null} {connected}/>
{:else if media && mediaAccess}
    <div class="playback-health" aria-label="Playback buffer health" data-delivery={mediaAccess.route}
         data-buffer-status={bufferReport?.status || 'Loading'}>
        <span class="buffer-health-state" class:status-error={bufferReport?.status === 'Buffering' || bufferReport?.status === 'Low buffer'}>
            {bufferReport?.status || 'Loading video'}
        </span>
        <span>{mediaAccess.route === 'cloudflare' ? 'Cloudflare' : mediaAccess.route === 'metal' ? 'Metal' : 'Server'}</span>
        {#if bufferReport}
            <span>{bufferDuration(bufferReport.seconds)} buffered</span>
            <span title="Video prepared on the server ahead of the room position">{bufferDuration(bufferReport.serverAhead)} ready at source</span>
            {#if bufferReport.mbps !== null}
                <span title="Recent segment download speed, including request latency">{bufferReport.mbps.toFixed(1)} Mbps · {bufferReport.downloadRate.toFixed(1)}× playback</span>
            {/if}
        {/if}
    </div>
{/if}
{#if fallbackNotice && media}
    <p class="delivery-notice" role="status">{fallbackNotice}</p>
{/if}
{#if qualityNotice && qualityFallbackItemId === item?.id}
    <p class="delivery-notice" role="status">{qualityNotice}. {media?.id === 'standard'
        ? 'Switched to Standard (up to 720p) for this video.' : 'Waiting for Standard (up to 720p) to be ready.'}</p>
{/if}
{#if item?.kind === 'upload' && media && !media.complete}
    <p class="inline-note">
        <Icon name="info" size={16}/>
        This video is still being prepared. {time(media.bufferedUntil)} is ready; seeking further may need more
        preparation or the remaining upload.
    </p>
{/if}
