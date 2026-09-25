import {createBassBoost} from './media-reactions.js';

// The six built-in analyzer/oscilloscope modes mirror Winamp's classic choices.
export const classicVisualizations = [
    {id: 'spectrum', name: 'Spectrum · normal', mode: 0},
    {id: 'fire', name: 'Spectrum · fire', mode: 1},
    {id: 'lines', name: 'Spectrum · line', mode: 2},
    {id: 'wave', name: 'Oscilloscope · lines', mode: 3},
    {id: 'dots', name: 'Oscilloscope · dots', mode: 4},
    {id: 'solid', name: 'Oscilloscope · solid', mode: 5},
];

// Presets contain equation functions as well as mutable parameter objects.
export function clonePreset(value) {
    if (Array.isArray(value)) return value.map(clonePreset);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clonePreset(entry)]));
    return value;
}

let library;
export function loadMilkdropLibrary() {
    library ||= Promise.all([
        import('butterchurn'),
        import('virtual:milkdrop-presets/base'),
        import('virtual:milkdrop-presets/extra'),
        import('virtual:milkdrop-presets/extra2'),
        import('virtual:milkdrop-presets/md1'),
    ]).then(([engine, ...packs]) => ({
        engine: engine.default,
        presets: Object.assign({}, ...packs.map(pack => pack.default)),
    })).catch(error => { library = null; throw error; });
    return library;
}

// Keep one Web Audio source per media element. Connect only after the context
// is running, so a blocked AudioContext can never silence native playback.
export function createAudioAnalysis() {
    let context;
    let destroyed = false;
    const sources = new Map();
    const streams = new Map();
    const effectRequests = new WeakMap();
    async function ready(gesture) {
        if (destroyed) return false;
        if (!context) {
            if (!gesture && !globalThis.navigator?.userActivation?.hasBeenActive) return false;
            const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (!AudioContext) return false;
            context = new AudioContext();
        }
        if (context.state !== 'running') await context.resume();
        return !destroyed && context.state === 'running';
    }
    function createAnalyser() {
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.8;
        return analyser;
    }
    function mediaSource(video) {
        if (!sources.has(video)) {
            const analyser = createAnalyser();
            const source = context.createMediaElementSource(video);
            source.connect(context.destination);
            source.connect(analyser);
            sources.set(video, {analyser, source});
        }
        return sources.get(video);
    }
    function streamSource(stream) {
        if (!streams.has(stream)) {
            const analyser = createAnalyser();
            const source = context.createMediaStreamSource(stream);
            source.connect(analyser);
            streams.set(stream, {analyser, source});
        }
        return streams.get(stream);
    }
    function releaseStream(stream) {
        effectRequests.delete(stream);
        const audio = streams.get(stream);
        audio?.effect?.destroy();
        audio?.source.disconnect();
        audio?.analyser.disconnect();
        if (audio?.playout) { audio.playout.pause(); audio.playout.srcObject = null; }
        audio?.output?.stream.getTracks().forEach(track => track.stop());
        if (audio?.syncVideo) {
            stream.removeEventListener('addtrack', audio.syncVideo);
            stream.removeEventListener('removetrack', audio.syncVideo);
        }
        streams.delete(stream);
    }
    return {
        async sample(video, gesture = false) {
            if (!video || !await ready(gesture)) return null;
            return mediaSource(video).analyser;
        },
        async bassBoost(video, enabled, gesture = false, wacko = false) {
            if (!video || destroyed) return false;
            const request = {};
            effectRequests.set(video, request);
            if (!enabled && !wacko) {
                sources.get(video)?.effect?.set(false, video.volume);
                return false;
            }
            if (!await ready(gesture) || effectRequests.get(video) !== request) return false;
            const audio = mediaSource(video);
            audio.effect ||= createBassBoost(context, audio.source);
            audio.effect.set(wacko ? 'wacko' : true, video.muted ? 0 : video.volume);
            return true;
        },
        async sampleStream(stream, gesture = false) {
            if (!stream?.getAudioTracks().length || !await ready(gesture)) return null;
            return streamSource(stream).analyser;
        },
        async boostStream(stream, enabled, gesture = false, wacko = false) {
            if (!stream || destroyed) return stream;
            const request = {};
            effectRequests.set(stream, request);
            if (!enabled && !wacko) {
                const audio = streams.get(stream);
                audio?.syncVideo?.();
                audio?.effect?.set(false, 1);
                return audio?.processed || stream;
            }
            if (!stream.getAudioTracks().length || !await ready(gesture) || effectRequests.get(stream) !== request) return stream;
            const audio = streamSource(stream);
            if (!audio.effect) {
                // Chromium needs a native element pulling the original remote
                // stream for Web Audio to receive samples. Keep it inaudible.
                audio.playout = new Audio();
                audio.playout.volume = 0;
                audio.playout.srcObject = stream;
                void audio.playout.play().catch(() => {});
                // Route processed audio back through the desktop video element:
                // its native volume/mute controls still apply after distortion.
                // Keep the original remote tracks alive and never double-play audio.
                audio.output = context.createMediaStreamDestination();
                audio.source.connect(audio.output);
                audio.effect = createBassBoost(context, audio.source, audio.output);
                audio.processed = new MediaStream([...stream.getVideoTracks(), ...audio.output.stream.getAudioTracks()]);
                audio.syncVideo = () => {
                    const tracks = stream.getVideoTracks();
                    for (const track of audio.processed.getVideoTracks()) if (!tracks.includes(track)) audio.processed.removeTrack(track);
                    for (const track of tracks) if (!audio.processed.getVideoTracks().includes(track)) audio.processed.addTrack(track);
                };
                stream.addEventListener('addtrack', audio.syncVideo);
                stream.addEventListener('removetrack', audio.syncVideo);
            }
            audio.syncVideo();
            audio.effect.set(wacko ? 'wacko' : true, 1);
            return audio.processed;
        },
        releaseStream,
        release(video) {
            effectRequests.delete(video);
            const audio = sources.get(video);
            audio?.effect?.destroy();
            audio?.source.disconnect();
            audio?.analyser.disconnect();
            sources.delete(video);
        },
        destroy() {
            destroyed = true;
            for (const {source, analyser, effect} of sources.values()) { effect?.destroy(); source.disconnect(); analyser.disconnect(); }
            for (const stream of streams.keys()) releaseStream(stream);
            sources.clear();
            streams.clear();
            context?.close().catch(() => {});
        },
    };
}

export function createVisualization(onError = () => {}, {loadLibrary = loadMilkdropLibrary} = {}) {
    const frequencies = new Uint8Array(512);
    const waveform = new Uint8Array(1024).fill(128);
    const pixels = new Uint8Array(256 * 2 * 4);
    const peaks = new Float32Array(256);
    let selection = 'spectrum';
    let analyser = null;
    let milkdrop = null;
    let milkCanvas = null;
    let generation = 0;
    let destroyed = false;
    let lastTime = null;
    let lastFrame = null;
    let running = false;

    function needsFrame(time) {
        // Allow sub-millisecond RAF jitter without accidentally halving the rate
        // on a 60 Hz display. Both the compositor and engine use this same clock.
        return !lastFrame || lastTime === null || time - lastTime >= 1000 / 30 - 0.5;
    }

    function releaseMilkdrop() {
        milkCanvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
        if (milkCanvas) milkCanvas.width = milkCanvas.height = 0;
        milkdrop = milkCanvas = null;
    }

    return {
        setAnalyser(value) {
            if (analyser === value) return;
            analyser = value;
            peaks.fill(0);
            lastFrame = null;
            lastTime = null;
        },
        setPlaying(value) {
            if (running !== !!value) lastTime = null;
            running = !!value;
        },
        resetClock() { lastTime = null; },
        needsFrame,
        async select(id) {
            const version = ++generation;
            selection = id;
            lastFrame = null;
            lastTime = null;
            onError('');
            if (!id.startsWith('milkdrop:')) { releaseMilkdrop(); return; }
            try {
                const {engine, presets} = await loadLibrary();
                if (destroyed || version !== generation) return;
                const preset = presets[id.slice(9)];
                if (!preset) throw new Error('This preset is unavailable. Choose another effect.');
                if (!milkdrop) {
                    milkCanvas = document.createElement('canvas');
                    milkCanvas.width = 960;
                    milkCanvas.height = 540;
                    const canvas = milkCanvas;
                    milkCanvas.addEventListener('webglcontextlost', () => {
                        if (canvas !== milkCanvas || destroyed) return;
                        milkdrop = milkCanvas = lastFrame = null;
                        onError('MilkDrop lost its graphics context. Select an effect to reload it.');
                    });
                    if (!milkCanvas.getContext('webgl2', {preserveDrawingBuffer: true})) throw new Error('MilkDrop needs WebGL 2. Classic effects are still available.');
                    milkdrop = engine.createVisualizer(null, milkCanvas, {width: 960, height: 540, pixelRatio: 1, textureRatio: 1});
                }
                // Butterchurn normalizes presets in place. Preserve the shared library.
                milkdrop.loadPreset(clonePreset(preset), 0);
            } catch (error) {
                if (destroyed || version !== generation) return;
                releaseMilkdrop();
                onError(error.message || 'Could not load MilkDrop. Choose a classic effect or retry.');
            }
        },
        frame(width, height, time, reducedMotion = false) {
            if (destroyed || selection === 'off') return null;
            if (lastFrame && (!running || reducedMotion)) { lastTime = null; return lastFrame; }
            // Reactions, resize events and room updates can redraw the compositor
            // much faster than the visualizer. Reuse its last frame independently
            // of those redraws and advance MilkDrop by actual elapsed time.
            if (!needsFrame(time)) return lastFrame;
            const elapsed = lastTime === null ? 1 / 30 : Math.min(0.1, Math.max(0, (time - lastTime) / 1000));
            lastTime = time;
            frequencies.fill(0);
            waveform.fill(128);
            if (analyser && running) {
                analyser.getByteFrequencyData(frequencies);
                analyser.getByteTimeDomainData(waveform);
            }
            for (let x = 0; x < 256; x++) {
                const bin = Math.min(511, Math.floor((512 ** (x / 255)) - 1));
                const amplitude = frequencies[bin];
                peaks[x] = Math.max(amplitude, peaks[x] - elapsed * 70);
                pixels.set([amplitude, peaks[x], 0, 255], x * 4);
                pixels.set([waveform[x * 4], 0, 0, 255], (256 + x) * 4);
            }
            if (milkdrop) {
                try {
                    const scale = Math.min(1, 1280 / width, 720 / height);
                    const w = Math.max(1, Math.round(width * scale));
                    const h = Math.max(1, Math.round(height * scale));
                    if (milkCanvas.width !== w || milkCanvas.height !== h) {
                        milkCanvas.width = w;
                        milkCanvas.height = h;
                        milkdrop.setRendererSize(w, h);
                    }
                    milkdrop.render({elapsedTime: elapsed, audioLevels: {
                        timeByteArray: waveform, timeByteArrayL: waveform, timeByteArrayR: waveform,
                    }});
                    return lastFrame = {canvas: milkCanvas};
                } catch {
                    releaseMilkdrop();
                    onError('This MilkDrop preset could not render. Choose another effect.');
                }
            }
            return lastFrame = {pixels, mode: classicVisualizations.find(effect => effect.id === selection)?.mode || 0};
        },
        destroy() { destroyed = true; generation++; releaseMilkdrop(); analyser = lastFrame = null; },
    };
}

export const audioVisualizationShader = `
    uniform sampler2D u_audioData;
    uniform float u_audioMode;
    uniform vec2 u_audioSize;
    vec4 audioVisualization(vec2 uv) {
        vec3 background = vec3(0.015, 0.022, 0.03);
        if (u_audioMode < 2.5) {
            float columns = u_audioMode > 1.5 ? 128.0 : 64.0;
            float x = (floor(uv.x * columns) + 0.5) / columns;
            vec2 band = texture2D(u_audioData, vec2(x, 0.25)).rg;
            float y = (1.0 - uv.y) / 0.88;
            float bar = step(y, band.r) * step(0.16, fract(uv.x * columns));
            float peak = (1.0 - step(0.008, abs(y - band.g))) * step(0.02, band.g);
            vec3 color = mix(vec3(0.12, 0.95, 0.34), vec3(1.0, 0.25, 0.08), y);
            if (u_audioMode > 0.5 && u_audioMode < 1.5) color = mix(vec3(1.0, 0.12, 0.015), vec3(1.0, 0.95, 0.25), y);
            return vec4(mix(background, color, max(bar, peak)), 1.0);
        }
        float x = u_audioMode > 3.5 && u_audioMode < 4.5 ? (floor(uv.x * 128.0) + 0.5) / 128.0 : uv.x;
        float wave = 0.5 + (texture2D(u_audioData, vec2(x, 0.75)).r - 0.5) * 0.85;
        float thickness = max(0.003, 1.5 / u_audioSize.y);
        float trace = 1.0 - smoothstep(thickness, thickness * 2.0, abs(uv.y - wave));
        if (u_audioMode > 3.5 && u_audioMode < 4.5) trace *= step(0.55, fract(uv.x * 128.0));
        if (u_audioMode > 4.5) trace = step(min(0.5, wave), uv.y) * step(uv.y, max(0.5, wave));
        return vec4(mix(background, vec3(0.25, 1.0, 0.55), trace), 1.0);
    }
`;
