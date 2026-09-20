<script>
    import {onMount, onDestroy} from 'svelte';
    import {createDesktopShare} from '../../../src/lib/desktop-share.js';
    import {casterPresets, normalizeDesktopQuality} from '../../../shared/desktop-quality.js';
    import {casterClient} from './client.js';
    import {Capture} from './capture.js';

    const bridge = window.caster;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('helltube-caster-settings') || '{}'); } catch {}
    let url = saved.url || 'https://', username = saved.username || '', password = '';
    let quality = normalizeDesktopQuality({...casterPresets.balanced, ...saved.quality});
    let user = null, loginBusy = false, error = '', audioError = '', notice = '';
    let mode = 'screen', sources = [], sourceId = '', loadingSources = false, portal = false;
    let captureBackend = bridge.platform === 'win32' && saved.captureBackend !== 'chromium' ? 'native' : 'chromium';
    let showCursor = saved.showCursor !== false, activeBackend = '';
    let audioSources = [], backend = '', selected = {}, audioSearch = '', audioFilter = 'all';
    let microphone = {echoCancellation: true, noiseSuppression: true, autoGainControl: false};
    let master = 0, compressor = true, levels = {}, channelErrors = {};
    let roomId = '', tab = 'audio', preset = 'balanced', settingsOpen = false;
    let region = {x: 0, y: 0, width: 1, height: 1}, regionStart;
    let capture = null, previewStream = null, previewElement, busyPreview = false, previewVisible = true;
    let startedAt = 0, elapsed = 0, sourceGeneration = 0;

    const client = casterClient(bridge, message => {
        if (message.type === 'error') error = message.message;
        if (message.type === 'session-ended') { user = null; stopPreview(); error = 'Your session ended. Sign in again.'; }
        if (message.type === 'connection' && message.status !== 'connected' && capture) {
            stopPreview(); notice = 'Capture stopped after the connection was lost. Preview again before going live.';
        }
    });
    const roomState = client.state;
    const share = createDesktopShare(client, {
        devices: {getDisplayMedia: async () => {
            if (!previewStream?.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('Start a preview before going live.');
            return previewStream;
        }}, secure: true, watchRemote: false, quality: () => normalizeDesktopQuality(quality),
    });
    const shareState = share.state, playbacks = share.playback;
    let previousStatus = 'idle';
    const unshare = shareState.subscribe(value => {
        if (value.status === 'sharing' && previousStatus !== 'sharing') startedAt = Date.now();
        if (value.status === 'idle' && previousStatus !== 'idle') stopPreview();
        previousStatus = value.status;
    });
    $: live = $shareState.status === 'sharing';
    $: locked = !!previewStream || busyPreview || $shareState.status !== 'idle';
    $: stats = Object.values($playbacks).find(value => value.local)?.stats;
    $: chosen = Object.values(selected).filter(value => value.enabled);
    $: filteredAudio = audioSources.filter(source => (audioFilter === 'all' || audioFilter === source.kind) &&
        `${source.label} ${source.detail || ''}`.toLowerCase().includes(audioSearch.toLowerCase()));
    $: chosenSource = sources.find(source => source.id === sourceId);
    $: if (previewElement) previewElement.srcObject = previewVisible ? previewStream : null;
    $: capture?.mixer?.update(chosen);
    $: capture?.mixer?.setMaster(master, compressor);

    function persist() {
        localStorage.setItem('helltube-caster-settings', JSON.stringify({url, username, quality: normalizeDesktopQuality(quality), captureBackend, showCursor}));
    }
    async function login() {
        loginBusy = true; error = ''; notice = '';
        const secret = password; password = '';
        try {
            const result = await bridge.login({url: url.trim(), username: username.trim(), password: secret});
            user = result.user; url = result.origin; persist();
        } catch (failure) { error = failure.message; }
        finally { loginBusy = false; }
    }
    async function logout() {
        share.stop(); stopPreview(); client.reset(); user = null; roomId = ''; password = '';
        await bridge.logout();
    }
    async function refreshSources() {
        if (locked) return;
        const generation = ++sourceGeneration;
        loadingSources = true;
        try {
            const result = await bridge.sources(mode === 'window' ? 'window' : 'screen', captureBackend);
            if (generation !== sourceGeneration) return;
            sources = result.sources; portal = result.portal;
            if (!sources.some(source => source.id === sourceId)) sourceId = sources[0]?.id || '';
        } catch (failure) { error = failure.message; }
        finally { if (generation === sourceGeneration) loadingSources = false; }
    }
    function changeMode(value) { mode = value; sourceId = ''; region = {x: 0, y: 0, width: 1, height: 1}; void refreshSources(); }
    async function refreshAudio(requestMicrophones = false) {
        try {
            if (requestMicrophones) {
                const permission = await navigator.mediaDevices.getUserMedia({audio: true});
                permission.getTracks().forEach(track => track.stop());
            }
            const result = await bridge.audioSources();
            const devices = await navigator.mediaDevices.enumerateDevices();
            audioSources = [...result.sources, ...devices.filter(device => device.kind === 'audioinput' && !['default', 'communications', ''].includes(device.deviceId))
                .map((device, index) => ({id: `mic:${device.deviceId}`, deviceId: device.deviceId, kind: 'microphone', label: device.label || `Microphone ${index + 1}`}))];
            backend = result.backend; audioError = result.error;
            if (!locked) {
                const available = new Set(audioSources.map(source => source.id));
                selected = Object.fromEntries(Object.entries(selected).filter(([id]) => available.has(id)));
            }
        } catch (failure) { audioError = failure.message; }
    }
    function include(source, enabled) {
        if (locked) return;
        const next = {...selected};
        if (enabled && source.kind !== 'microphone') {
            for (const [id, value] of Object.entries(next)) {
                if (value.kind !== 'microphone' && (value.kind === 'system' || source.kind === 'system')) next[id] = {...value, enabled: false};
            }
        }
        next[source.id] = {...source, gain: 0, muted: false, solo: false, pan: 0, delay: 0, ...next[source.id], enabled};
        selected = next;
    }
    function adjust(id, key, value) { selected = {...selected, [id]: {...selected[id], [key]: value}}; }
    async function startPreview() {
        if (locked || !sourceId) return;
        error = ''; notice = ''; channelErrors = {}; busyPreview = true; previewVisible = true;
        const current = new Capture(bridge, message => {
            share.stop(); stopPreview(); notice = message || 'The selected screen or application stopped sharing.';
        }, (id, message) => { channelErrors = {...channelErrors, [id]: message}; });
        capture = current;
        try {
            quality = normalizeDesktopQuality(quality); persist();
            const stream = await current.start({sourceId, region: mode === 'region' ? {...region} : null,
                quality, captureBackend, showCursor, audioSources: chosen, audioSettings: {master, compressor, microphone}});
            if (capture !== current) { current.stop(); return; }
            activeBackend = current.backend; previewStream = stream;
        } catch (failure) { if (capture === current) { error = failure.message; stopPreview(); } }
        finally { if (capture === current) busyPreview = false; }
    }
    function stopPreview() {
        if (previewElement) { previewElement.pause(); previewElement.srcObject = null; }
        capture?.stop(); capture = null; previewStream = null; busyPreview = false; levels = {}; activeBackend = '';
    }
    function togglePreview() {
        previewVisible = !previewVisible;
        // Detach before Svelte removes the element: a detached playing video
        // can otherwise continue consuming frames until garbage collection.
        if (!previewVisible && previewElement) { previewElement.pause(); previewElement.srcObject = null; }
    }
    function stopAll() { share.stop(); stopPreview(); }
    function choosePreset(value) { preset = value; if (casterPresets[value]) quality = normalizeDesktopQuality({...quality, ...casterPresets[value]}); }
    function coordinate(event) {
        const rect = event.currentTarget.getBoundingClientRect();
        return {x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))};
    }
    function regionDown(event) {
        if (locked || mode !== 'region') return;
        regionStart = coordinate(event); event.currentTarget.setPointerCapture(event.pointerId);
    }
    function regionMove(event) {
        if (!regionStart) return;
        const point = coordinate(event);
        region = {x: Math.min(regionStart.x, point.x), y: Math.min(regionStart.y, point.y),
            width: Math.max(0.01, Math.abs(point.x - regionStart.x)), height: Math.max(0.01, Math.abs(point.y - regionStart.y))};
    }
    function setRegion(key, value) { region = {...region, [key]: Math.min(1, Math.max(key === 'x' || key === 'y' ? 0 : 0.01, Number(value) / 100))}; }
    const fmt = (value, suffix = '', digits = 0) => Number.isFinite(value) ? value.toFixed(digits) + suffix : '—';
    const duration = seconds => `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    onMount(() => {
        void refreshSources(); void refreshAudio();
        const meterTimer = setInterval(() => {
            if (capture?.mixer) levels = capture.mixer.levels();
            elapsed = live ? Math.floor((Date.now() - startedAt) / 1000) : 0;
        }, 100);
        return () => clearInterval(meterTimer);
    });
    onDestroy(() => { unshare(); share.dispose(); client.dispose(); stopPreview(); });
</script>

<svelte:window on:keydown={event => { if (event.key === 'Escape' && settingsOpen) settingsOpen = false; }}/>

<header class="app-header">
    <div class="brand"><span class="brand-mark">h<span>▶</span></span><div><strong>helltube<span class="brand-caster">caster</span></strong><small>YOUR SCREEN. YOUR MIX. YOUR PEOPLE.</small></div></div>
    <div class="header-status"><span class:connected={$roomState.status === 'connected'} class="dot"></span>
        {$roomState.status === 'connected' ? 'Connected to Helltube' : user ? 'Reconnecting…' : 'Not connected'}
        <span class="platform">{bridge.platform === 'win32' ? 'WINDOWS' : 'LINUX'} / v0.1.2</span></div>
</header>

<main class="workspace">
    <aside class="sidebar">
        <section class="panel connection-panel">
            <div class="panel-heading"><h2>Destination</h2><span class="step">01</span></div>
            {#if !user}
                <p class="subtle">Connect to your Helltube and pick a room.</p>
                <form on:submit|preventDefault={login}>
                    <label for="frontend">Frontend URL</label><input id="frontend" type="url" placeholder="https://helltube.example" bind:value={url} required disabled={loginBusy}/>
                    <label for="username">Username</label><input id="username" autocomplete="username" bind:value={username} required disabled={loginBusy}/>
                    <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" bind:value={password} required disabled={loginBusy}/>
                    <button class="primary full" type="submit" disabled={loginBusy}>{loginBusy ? 'Connecting…' : 'Connect to Helltube'} <span>↗</span></button>
                </form>
                <p class="fine">Your password and session stay in memory for this app session.</p>
            {:else}
                <div class="account"><span class="avatar">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</span><div><strong>{user.displayName || user.username}</strong><small title={url}>{url.replace(/^https?:\/\//, '')}</small></div><button class="text-button" on:click={logout}>Sign out</button></div>
                <label for="room">Broadcast to room</label>
                <select id="room" bind:value={roomId} disabled={locked || $roomState.status !== 'connected'} on:change={() => client.join(roomId)}>
                    <option value="" disabled>Select a room</option>
                    {#each $roomState.rooms as room}<option value={room.id}>{room.name} · {room.memberCount} online</option>{/each}
                </select>
                <p class="fine">{$roomState.joined ? 'Room ready. Everyone in this room can watch your share.' : 'Join a room to go live.'}</p>
            {/if}
        </section>

        <section class="panel sources-panel">
            <div class="panel-heading"><h2>Capture source</h2><span class="step">02</span></div>
            {#if bridge.platform === 'win32'}
                <label class="fine" for="capture-backend">Capture engine</label>
                <select id="capture-backend" bind:value={captureBackend} disabled={locked} on:change={() => { sourceId = ''; persist(); void refreshSources(); }}>
                    <option value="native">Native Windows (recommended)</option>
                    <option value="chromium">Chromium compatibility</option>
                </select>
                {#if captureBackend === 'native'}
                    <p class="fine">{mode === 'window' ? 'Native window capture with independent cursor rendering.' : 'DXGI monitor capture bypasses Windows Graphics Capture.'}</p>
                    <label class="check"><input type="checkbox" bind:checked={showCursor} disabled={locked} on:change={persist}/>Show cursor in broadcast</label>
                {/if}
            {/if}
            <div class="segmented" aria-label="Capture type">
                {#each [['screen', 'Monitor'], ['window', 'Application'], ['region', 'Region']] as [value, label]}
                    <button class:active={mode === value} aria-pressed={mode === value} disabled={locked} on:click={() => changeMode(value)}>{label}</button>
                {/each}
            </div>
            <div class="source-list">
                {#each sources as source}
                    <button class="source" class:selected={sourceId === source.id} disabled={locked} on:click={() => sourceId = source.id} aria-pressed={sourceId === source.id}>
                        {#if source.thumbnail}<img src={source.thumbnail} alt=""/>{:else}<span class="source-symbol">▣</span>{/if}
                        <span>{source.name}</span><span class="source-check">{sourceId === source.id ? '●' : '○'}</span>
                    </button>
                {/each}
                {#if !sources.length}<p class="subtle">{loadingSources ? 'Finding capture sources…' : 'No sources available. Open an application, then refresh.'}</p>{/if}
            </div>
            <button class="text-button" disabled={locked || loadingSources} on:click={refreshSources}>↻ {loadingSources ? 'Refreshing…' : 'Refresh sources'}</button>
            {#if portal}<p class="fine">Your desktop’s permission dialog will select the screen or window when you preview.</p>{/if}
            {#if mode === 'region'}
                <div class="region-fields">
                    {#each [['x', 'Left'], ['y', 'Top'], ['width', 'Width'], ['height', 'Height']] as [key, label]}
                        <label>{label} %<input type="number" min={key === 'x' || key === 'y' ? 0 : 1} max="100" step="0.1" value={(region[key] * 100).toFixed(1)} disabled={locked} on:input={event => setRegion(key, event.currentTarget.value)}/></label>
                    {/each}
                </div><p class="fine">Drag a rectangle on the source image, or set percentages here. The region follows the selected monitor.</p>
            {/if}
        </section>
        <div class="sidebar-note"><span>↗</span><p>One live feed, shared together.<br/>Preview locally, then go live.</p></div>
    </aside>

    <div class="studio">
        {#if error || $shareState.error}<div class="banner error" role="alert">{error || $shareState.error}<button aria-label="Dismiss error" on:click={() => { error = ''; if ($shareState.error) share.stop(); }}>×</button></div>{/if}
        {#if notice}<div class="banner" role="status">{notice}<button aria-label="Dismiss notice" on:click={() => notice = ''}>×</button></div>{/if}
        <section class="panel preview-panel">
            <div class="panel-heading"><h2>Program preview <span class="tag">{mode === 'window' ? 'APPLICATION' : mode.toUpperCase()}</span></h2>
                <span class="preview-status" class:is-live={live}><span class="dot"></span>{live ? 'LIVE' : previewStream ? 'PREVIEW ONLY' : 'STANDBY'}<span class="duration">{duration(elapsed)}</span></span>
            </div>
            <div class="preview-stage">
                {#if previewStream}
                    {#if previewVisible}
                        <video bind:this={previewElement} autoplay muted playsinline aria-label="Outgoing broadcast preview"></video>
                    {:else}
                        <div class="preview-empty"><h2>Preview hidden</h2><p>Capture and audio remain active.{live ? ' Your viewers still receive the broadcast.' : ' Nothing is being shared yet.'}</p></div>
                    {/if}
                    <span class="preview-badge">{live ? 'ON AIR' : 'LOCAL PREVIEW · NOT SHARING'} · {activeBackend}</span>
                {:else if mode === 'region' && chosenSource?.thumbnail}
                    <div class="region-picker" role="img" aria-label="Drag to select capture region; numeric controls are in the sidebar"
                        on:pointerdown={regionDown} on:pointermove={regionMove} on:pointerup={() => regionStart = null} on:pointercancel={() => regionStart = null}>
                        <img src={chosenSource.thumbnail} alt="Selected capture source" draggable="false"/>
                        <div class="region-selection" style={`left:${region.x * 100}%;top:${region.y * 100}%;width:${Math.min(region.width, 1 - region.x) * 100}%;height:${Math.min(region.height, 1 - region.y) * 100}%`}></div>
                    </div>
                {:else}
                    <div class="preview-empty"><span class="viewfinder">⌑</span><h1>Your next broadcast starts here.</h1><p>Select a source and build your audio mix.<br/>Preview it before sharing with your room.</p><span class="standby-label">HELLTUBE CASTER / STANDBY</span></div>
                {/if}
            </div>
            <div class="preview-controls"><div><strong>{chosenSource?.name || 'No capture source selected'}</strong><small>{quality.width} × {quality.height} max · {quality.frameRate} fps · {chosen.length ? `${chosen.length} audio source${chosen.length === 1 ? '' : 's'}` : 'Video only'}</small></div>
                <div class="actions">
                    {#if previewStream}<button on:click={togglePreview}>{previewVisible ? 'Hide preview' : 'Show preview'}</button>{/if}
                    {#if locked}<button on:click={stopAll}>{live ? '■ Stop sharing' : 'Stop preview'}</button>{:else}<button disabled={!sourceId || loadingSources} on:click={startPreview}>▻ Start preview</button>{/if}
                    <button class="primary go-live" class:live disabled={!previewStream || !$roomState.joined || $shareState.status !== 'idle'} on:click={() => { error = ''; void share.start(); }}>
                        <span>●</span>{live ? 'You’re live' : $shareState.status === 'starting' ? 'Connecting stream…' : busyPreview ? 'Preparing…' : 'Go live'}
                    </button>
                </div>
            </div>
        </section>

        <section class="panel controls-panel">
            <div class="tabs"><button class:active={tab === 'audio'} on:click={() => tab = 'audio'}>Audio mixer <span>{chosen.length}</span></button><button class:active={tab === 'quality'} on:click={() => tab = 'quality'}>Encoding & quality</button><span class="tab-note">{tab === 'audio' ? 'ONLY YOUR SELECTED SOURCES GO LIVE' : 'TUNED FOR HELLTUBE LIVE SHARING'}</span></div>
            {#if tab === 'audio'}
                <div class="mixer-layout">
                    <div class="audio-library">
                        <div class="small-heading"><h3>Audio sources</h3><button class="text-button" disabled={locked} on:click={() => refreshAudio()}>↻ Refresh</button></div>
                        <input aria-label="Filter audio sources" type="search" placeholder="Find an application…" bind:value={audioSearch}/>
                        <div class="filter-row">{#each [['all', 'All'], ['application', 'Apps'], ['microphone', 'Mics'], ['system', 'Desktop']] as [value, label]}<button class:active={audioFilter === value} on:click={() => audioFilter = value}>{label}</button>{/each}</div>
                        <div class="audio-options">
                            {#each filteredAudio as source}
                                <label class="audio-option"><input type="checkbox" checked={!!selected[source.id]?.enabled} disabled={locked} on:change={event => include(source, event.currentTarget.checked)}/><span><strong>{source.label}</strong><small>{source.kind === 'application' ? source.detail || `Application${source.pid ? ' · PID ' + source.pid : ''}` : source.kind === 'microphone' ? 'Microphone / input' : 'Entire desktop output'}</small></span></label>
                            {/each}
                            {#if !filteredAudio.length}<p class="fine">No matching sources. Play audio in an application, then refresh.</p>{/if}
                        </div>
                        <button class="text-button" disabled={locked} on:click={() => refreshAudio(true)}>+ Enable microphone access</button>
                        <p class="fine">{backend}. Applications and desktop output are alternative selections. Stop preview to add or remove sources.</p>
                        {#if audioError}<p class="inline-warning" role="status">{audioError}</p>{/if}
                    </div>
                    <div class="mix-channels">
                        <div class="small-heading"><h3>Share mix</h3><button class="text-button" on:click={() => settingsOpen = !settingsOpen}>Microphone processing {settingsOpen ? '−' : '+'}</button></div>
                        {#if settingsOpen}<div class="mic-settings">{#each [['echoCancellation', 'Echo cancellation'], ['noiseSuppression', 'Noise suppression'], ['autoGainControl', 'Automatic gain']] as [key, label]}<label><input type="checkbox" bind:checked={microphone[key]} disabled={locked}/>{label}</label>{/each}<small>Applied when preview starts.</small></div>{/if}
                        {#each chosen as channel}
                            <div class="channel" class:muted={channel.muted}>
                                <div class="channel-title"><strong>{channel.label}</strong><div><button class:enabled={channel.muted} aria-pressed={channel.muted} aria-label={`Mute ${channel.label}`} on:click={() => adjust(channel.id, 'muted', !channel.muted)}>M</button><button class:solo={channel.solo} aria-pressed={channel.solo} aria-label={`Solo ${channel.label}`} on:click={() => adjust(channel.id, 'solo', !channel.solo)}>S</button></div></div>
                                <meter min="-60" max="0" low="-24" high="-6" optimum="-12" value={levels[channel.id] ?? -60} aria-label={`${channel.label} level`}></meter>
                                <div class="channel-gain"><input aria-label={`${channel.label} gain`} type="range" min="-60" max="12" step="0.5" value={channel.gain} on:input={event => adjust(channel.id, 'gain', Number(event.currentTarget.value))}/><output>{channel.gain > 0 ? '+' : ''}{channel.gain.toFixed(1)} dB</output></div>
                                <div class="channel-options"><label>Pan <input type="range" min="-1" max="1" step="0.05" value={channel.pan} aria-label={`${channel.label} pan`} on:input={event => adjust(channel.id, 'pan', Number(event.currentTarget.value))}/></label><label>Delay <input type="number" min="0" max="500" step="5" value={channel.delay} aria-label={`${channel.label} delay in milliseconds`} on:input={event => adjust(channel.id, 'delay', Number(event.currentTarget.value))}/> ms</label></div>
                                {#if channelErrors[channel.id]}<p class="inline-warning" role="status">{channelErrors[channel.id]}</p>{/if}
                            </div>
                        {/each}
                        {#if !chosen.length}<div class="mix-empty"><span>≋</span><strong>A little silence, for now.</strong><p>Select applications or microphones to build your mix.<br/>Nothing is included automatically.</p></div>{/if}
                        <div class="master-channel"><div class="small-heading"><h3>Master output</h3><span>{fmt(levels.master ?? -60, ' dB', 1)}</span></div><meter min="-60" max="0" value={levels.master ?? -60} aria-label="Master output level"></meter><div class="channel-gain"><input aria-label="Master gain" type="range" min="-60" max="6" step="0.5" bind:value={master}/><output>{master.toFixed(1)} dB</output></div><label class="check"><input type="checkbox" bind:checked={compressor}/>Peak compressor</label><small>Preview is muted locally to prevent feedback. Meters show the outgoing mix.</small></div>
                    </div>
                </div>
            {:else}
                <div class="quality-menu">
                    <div class="quality-intro"><div><h3>Make every frame count.</h3><p>One adaptive stream is sent to all viewers. Choose a quality their connections can support.</p></div><span class="ceiling">1080p60 / 6 Mbps MAX</span></div>
                    <fieldset disabled={locked}>
                        <div class="quality-presets">{#each [['balanced', 'Balanced', '720p · 30 fps'], ['detail', 'Fine detail', '1080p · 30 fps'], ['motion', 'Fast motion', '1080p · 60 fps'], ['constrained', 'Low bandwidth', '480p · 24 fps']] as [value, label, detail]}<button class:selected={preset === value} on:click={() => choosePreset(value)}><strong>{label}</strong><small>{detail}</small></button>{/each}</div>
                        <div class="quality-grid">
                            <label>Output resolution<select value={`${quality.width}x${quality.height}`} on:change={event => { const [width, height] = event.currentTarget.value.split('x').map(Number); quality = {...quality, width, height}; preset = 'custom'; }}><option value="854x480">854 × 480</option><option value="1280x720">1280 × 720</option><option value="1600x900">1600 × 900</option><option value="1920x1080">1920 × 1080</option></select><small>Preserves aspect ratio; smaller captures are not enlarged.</small></label>
                            <label>Frame rate<select bind:value={quality.frameRate} on:change={() => preset = 'custom'}>{#each [15, 24, 30, 48, 60] as fps}<option value={fps}>{fps} fps</option>{/each}</select></label>
                            <label>Video bitrate ceiling (kbps)<input type="number" min="300" max="6000" step="100" value={quality.videoBitrate / 1000} on:change={event => { quality = normalizeDesktopQuality({...quality, videoBitrate: Number(event.currentTarget.value) * 1000}); preset = 'custom'; }}/><small>Adaptive bitrate, 300–6,000 kbps. Allow extra upload capacity for overhead.</small></label>
                            <label>Video codec<select bind:value={quality.codec}><option value="auto">Automatic · prefer efficient hardware</option><option value="h264">H.264 · negotiated relay profile</option><option value="vp8">VP8</option></select><small>Automatic retries supported profiles. GPU availability is controlled by the driver and WebRTC.</small></label>
                            <label>Content priority<select bind:value={quality.contentHint}><option value="motion">Motion · games and video</option><option value="detail">Detail · artwork and desktops</option><option value="text">Text · code and presentations</option></select></label>
                            <label>When bandwidth is limited<select bind:value={quality.degradationPreference}><option value="balanced">Balance frame rate and resolution</option><option value="maintain-framerate">Keep motion smooth; reduce resolution</option><option value="maintain-resolution">Keep detail sharp; reduce frame rate</option></select></label>
                            <label>Opus audio bitrate<select bind:value={quality.audioBitrate}>{#each [32000, 48000, 64000, 96000, 128000] as bitrate}<option value={bitrate}>{bitrate / 1000} kbps</option>{/each}</select><small>48 kHz audio with packet-loss protection.</small></label>
                            <div class="audio-encoding"><label class="check"><input type="checkbox" bind:checked={quality.stereo}/>Stereo audio</label><label class="check"><input type="checkbox" bind:checked={quality.dtx}/>Reduce audio traffic during silence (DTX)</label></div>
                        </div>
                    </fieldset>
                    <p class="fine">{locked ? 'Stop preview to change capture or encoding settings. Mixer controls remain available while live.' : 'Settings apply on your next preview. Helltube ends live shares after four hours.'}</p>
                </div>
            {/if}
        </section>
        <footer class="telemetry"><span class="telemetry-title">STREAM HEALTH</span><span><b>{fmt(stats?.bitrate / 1000, ' kbps')}</b> video</span><span><b>{fmt(stats?.fps, ' fps')}</b></span><span><b>{fmt(stats?.rttMs, ' ms')}</b> relay RTT</span><span><b>{fmt(stats?.encoderLoad, '%')}</b> encoder time</span><span title={stats?.encoder || ''}>{stats?.codec || 'Codec —'}{stats?.width ? ` · ${stats.width}×${stats.height}` : ''}</span><span>{stats?.limitation && stats.limitation !== 'none' ? `Limited by ${stats.limitation}` : live ? '● Broadcasting' : 'Ready when you are'}</span></footer>
    </div>
</main>
