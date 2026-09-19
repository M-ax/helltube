<script>
    import {onMount, onDestroy} from 'svelte';
    import {classicVisualizations, createVisualization, loadMilkdropLibrary} from '../lib/audio-visualizations.js';
    export let renderer;
    export let analyser = null;
    export let playing = false;
    export let external = false;
    export let webgl = false;
    let selected = 'spectrum';
    let engine;
    let names = [];
    let search = '';
    let loading = false;
    let error = '';
    let shuffle = false;
    let disposed = false;
    $: choices = names.filter(name => name.toLowerCase().includes(search.toLowerCase()));
    $: if (engine) engine.setAnalyser(analyser);
    $: if (engine) engine.setPlaying(playing);
    $: if (engine && renderer) renderer.setAudioVisualization(selected === 'off' ? null : engine, playing);

    async function loadLibrary() {
        if (loading || names.length) return;
        loading = true;
        error = '';
        try {
            const {presets} = await loadMilkdropLibrary();
            if (!disposed) names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
        } catch { if (!disposed) error = 'Could not load the MilkDrop library. Try again.'; }
        finally { if (!disposed) loading = false; }
    }

    async function choose(value) {
        selected = value;
        try { localStorage.setItem('helltube.visualization', value); } catch {}
        await engine?.select(value);
        if (!disposed) renderer?.setAudioVisualization(value === 'off' ? null : engine, playing);
    }

    function randomPreset() {
        const pool = choices.filter(name => `milkdrop:${name}` !== selected);
        if (pool.length) void choose(`milkdrop:${pool[Math.floor(Math.random() * pool.length)]}`);
    }

    onMount(() => {
        engine = createVisualization(message => error = message);
        try {
            const saved = localStorage.getItem('helltube.visualization');
            if (saved === 'off' || saved?.startsWith('milkdrop:') || classicVisualizations.some(effect => effect.id === saved)) selected = saved;
        } catch {}
        void choose(selected);
        if (selected.startsWith('milkdrop:')) void loadLibrary();
        const timer = setInterval(() => {
            if (shuffle && playing && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) randomPreset();
        }, 30000);
        return () => clearInterval(timer);
    });
    onDestroy(() => { disposed = true; renderer?.setAudioVisualization(null); engine?.destroy(); });
</script>

<div class="audio-visualizations" aria-label="Audio visualization library">
    <div class="visualization-heading"><strong>Visualizations</strong><span>On this device</span>
        <button type="button" class="button secondary small" class:active={selected === 'off'} aria-pressed={selected === 'off'} on:click={() => choose(selected === 'off' ? 'spectrum' : 'off')}>{selected === 'off' ? 'Turn on' : 'Turn off'}</button>
    </div>
    <div class="classic-effects" role="group" aria-label="Classic Winamp effects">
        {#each classicVisualizations as effect}
            <button type="button" class:active={selected === effect.id} aria-pressed={selected === effect.id} on:click={() => choose(effect.id)}>{effect.name}</button>
        {/each}
    </div>
    <details class="milkdrop-library" on:toggle={event => { if (event.currentTarget.open) void loadLibrary(); }}>
        <summary>MilkDrop library {names.length ? `· ${names.length} presets` : '· Winamp classics and more'}</summary>
        {#if loading}<p role="status">Loading MilkDrop presets…</p>{/if}
        {#if names.length}
            <input type="search" bind:value={search} placeholder="Search presets or artists" aria-label="Search MilkDrop presets"/>
            <select size="6" aria-label="MilkDrop preset" value={selected.startsWith('milkdrop:') ? selected.slice(9) : ''} on:change={event => choose(`milkdrop:${event.currentTarget.value}`)}>
                {#each choices as name}<option value={name}>{name}</option>{/each}
            </select>
            {#if !choices.length}<p>No matching presets.</p>{/if}
            <div class="milkdrop-actions"><button type="button" class="button secondary small" disabled={!choices.length} on:click={randomPreset}>Random preset</button>
                <label><input type="checkbox" bind:checked={shuffle}/>Shuffle every 30 seconds</label></div>
        {:else if !loading}<button type="button" class="button secondary small" on:click={loadLibrary}>Load presets</button>{/if}
        <p>MilkDrop 1, MilkDrop 2, and the full Butterchurn extra packs. Native AVS and third-party Winamp plug-ins are not supported.</p>
    </details>
    {#if selected.startsWith('milkdrop:')}<p class="preset-name">{selected.slice(9)}</p>{/if}
    {#if !webgl}<p role="status">WebGL effects are unavailable on this device. Audio playback remains available.</p>
    {:else if external}<p>Spotify keeps its audio private. Effects are ambient, without beat detection.</p>
    {:else if !analyser}<p>Click a visualization to enable audio analysis on this device.</p>{/if}
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
</div>

<style>
    .audio-visualizations { background: #10151c; color: #c7ccd4; border-top: 1px solid #30343d; padding: 14px 18px; font-size: 12px; }
    .visualization-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .visualization-heading strong { color: #f0f2f6; font-size: 14px; }
    .visualization-heading > button { margin-left: auto; }
    .classic-effects { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
    .classic-effects button { border: 1px solid #353d47; border-radius: 6px; background: #1a2029; color: #c7ccd4; padding: 10px 6px; font: inherit; cursor: pointer; }
    .classic-effects button.active { background: #283829; border-color: #7bcb7f; color: #b8fbb0; }
    summary { cursor: pointer; padding: 12px 0; color: #f0f2f6; }
    .milkdrop-library > input, select { display: block; width: 100%; background: #171d25; border: 1px solid #353d47; border-radius: 4px; color: #e2e5e9; padding: 8px; margin-bottom: 8px; font: inherit; }
    option { padding: 5px; }
    .milkdrop-actions, label { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .milkdrop-actions input[type='checkbox'] { width: 16px; height: 16px; min-height: 16px; padding: 0; accent-color: #7bcb7f; }
    p { margin: 10px 0 0; line-height: 1.5; }
    .preset-name { color: #b8fbb0; overflow-wrap: anywhere; }
    @media (max-width: 520px) { .classic-effects { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
