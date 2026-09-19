<script>
    import Icon from './Icon.svelte';
    export let room;
    export let connected = false;
    export let onCommand;
    $: automation = room.automation;
    $: current = room.current;
</script>

<aside class="queue-panel ben-zone-panel" aria-label="The Ben Zone automatic channel">
    <div class="queue-header">
        <div><p class="eyebrow">CARTOONS × BANGERS</p><h2>The rotation<span class="accent">.</span></h2></div>
        <Icon name="refresh" size={21}/>
    </div>
    <div class="ben-zone-details">
        <p class="ben-zone-status" role="status">{automation.message}</p>
        {#if current?.cartoon}
            <p class="eyebrow">ON SCREEN · LIVE</p>
            <a class="ben-zone-current" href={current.cartoon.url} target="_blank" rel="noopener noreferrer">{current.cartoon.channel}<Icon name="external" size={13}/></a>
            <p class="ben-zone-stream-title">{current.cartoon.title}</p>
            <p class="eyebrow">ON THE SPEAKERS</p>
            <a class="ben-zone-current" href={current.soundtrack.url} target="_blank" rel="noopener noreferrer">{current.soundtrack.title}<Icon name="external" size={13}/></a>
            <span class="tag">{current.soundtrack.genre}</span>
        {/if}
        <div class="ben-zone-actions">
            <button class="button secondary small" disabled={!connected || !current} on:click={() => onCommand({type: 'control', action: 'skip'})}><Icon name="next" size={16}/>Next song</button>
            <button class="button secondary small" disabled={!connected || !current} on:click={() => onCommand({type: 'control', action: 'next-cartoon'})}><Icon name="refresh" size={16}/>Next cartoon</button>
        </div>
        <p class="field-help">Songs shuffle automatically. Cartoons change about every {Math.round(automation.cartoonIntervalSeconds / 60)} minutes, between songs. Everything stops when the room is empty.</p>
        <h3 class="ben-zone-list-heading">In the mix <span class="count">{automation.tracks.length}</span></h3>
        <ul class="ben-zone-tracks">
            {#each automation.tracks as track (track.url)}
                <li class:playing={current?.soundtrack?.url === track.url}>
                    <a href={track.url} target="_blank" rel="noopener noreferrer">{track.title}<span>{track.genre}</span></a>
                </li>
            {/each}
        </ul>
        <p class="field-help">Cartoon audio is replaced by the soundtrack. Live channels: {automation.channels.join(', ')}.</p>
    </div>
</aside>

<style>
    .ben-zone-details { padding: 0 20px 22px; }
    .ben-zone-status { color: var(--accent); font-size: 12px; line-height: 1.6; margin: 0 0 24px; }
    .ben-zone-current { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; line-height: 1.6; margin: 6px 0 8px; }
    .ben-zone-current :global(svg) { flex-shrink: 0; }
    .ben-zone-stream-title { color: var(--quiet); font-size: 11px; line-height: 1.6; margin: 0 0 22px; }
    .ben-zone-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 22px 0 14px; }
    .ben-zone-actions .button { flex: 1; white-space: nowrap; }
    .ben-zone-list-heading { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 26px 0 10px; }
    .ben-zone-tracks { list-style: none; padding: 0; margin: 0 0 18px; }
    .ben-zone-tracks li { border-top: 1px solid var(--line); }
    .ben-zone-tracks a { display: block; padding: 12px 0; font-size: 11px; line-height: 1.6; }
    .ben-zone-tracks span { display: block; font-size: 10px; color: var(--quiet); }
    .ben-zone-tracks .playing a, a:hover { color: var(--accent); }
</style>
