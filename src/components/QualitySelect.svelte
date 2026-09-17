<script context="module">
    let nextId = 0;
</script>

<script>
    import Icon from './Icon.svelte';
    import {qualityReady} from '../lib/media-quality.js';

    export let qualities = [];
    export let value = 'standard';
    export let position = 0;
    export let controlsVisible = true;
    export let onChange;

    const listboxId = `quality-options-${++nextId}`;
    let trigger;
    let open = false;
    let activeId = null;

    $: selected = qualities.find(quality => quality.id === value);
    $: available = qualities.filter(quality => qualityReady(quality, position));
    $: if (!controlsVisible) open = false;
    $: if (!available.some(quality => quality.id === activeId)) activeId = available[0]?.id;

    function show() {
        if (!controlsVisible) return;
        activeId = available.find(quality => quality.id === value)?.id || available[0]?.id;
        open = true;
    }

    function choose(id) {
        if (!available.some(quality => quality.id === id)) return;
        open = false;
        trigger.focus({preventScroll: true});
        onChange(id);
    }

    function keydown(event) {
        if (event.key === 'Escape' || event.key === 'Tab') {
            if (open && event.key === 'Escape') event.preventDefault();
            open = false;
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            if (!open) show();
            else if (available.length) {
                const index = available.findIndex(quality => quality.id === activeId);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
                activeId = available[next].id;
            }
        } else if (open && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            choose(activeId);
        }
    }

    function dismissOutside(node) {
        const outside = event => { if (!node.contains(event.target)) open = false; };
        const blur = () => open = false;
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('focusin', outside);
        window.addEventListener('blur', blur);
        return {destroy() {
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('focusin', outside);
            window.removeEventListener('blur', blur);
        }};
    }
</script>

<div class="quality-picker" use:dismissOutside>
    <button class="quality-select" type="button" role="combobox" bind:this={trigger} {value}
            aria-label="Video quality on this device" title="Quality is just for you"
            aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId}
            aria-activedescendant={open && activeId ? `${listboxId}-${activeId}` : undefined}
            on:click={() => open ? open = false : show()} on:keydown={keydown}>
        <span>{selected?.label || 'Video quality'}</span>
        <Icon name={open ? 'down' : 'up'} size={12}/>
    </button>
    {#if open}
        <div class="quality-menu" id={listboxId} role="listbox" aria-label="Video quality" tabindex="-1">
            {#each qualities as quality (quality.id)}
                <button class="quality-option" class:active={activeId === quality.id} type="button" role="option"
                        id={`${listboxId}-${quality.id}`} value={quality.id} tabindex="-1"
                        aria-selected={value === quality.id} disabled={!qualityReady(quality, position)}
                        on:mousedown|preventDefault on:click={() => choose(quality.id)}
                        on:pointermove={() => { if (qualityReady(quality, position)) activeId = quality.id; }}>
                    <span class="quality-check">{#if value === quality.id}<Icon name="check" size={14}/>{/if}</span>
                    <span>{quality.label}</span>
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
    .quality-picker {
        position: relative;
        min-width: 0;
        font: 10px var(--mono);
    }

    .quality-select {
        display: flex;
        align-items: center;
        gap: 6px;
        max-width: 160px;
        min-height: 30px;
        padding: 3px 6px;
        border: 1px solid #493d48;
        border-radius: 5px;
        background: transparent;
        color: #e5dce3;
        font: inherit;
    }

    .quality-select > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .quality-select:hover, .quality-select[aria-expanded="true"] {
        border-color: var(--muted);
        color: var(--text);
    }

    .quality-select:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
    }

    .quality-menu {
        position: absolute;
        bottom: calc(100% + 8px);
        left: 0;
        z-index: 1;
        width: max-content;
        min-width: 100%;
        max-width: min(240px, calc(100vw - 32px));
        padding: 4px;
        border: 1px solid #493d48;
        border-radius: 7px;
        background: var(--panel);
        color: var(--text);
        box-shadow: 0 8px 24px #0008;
    }

    .quality-option {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        min-height: 34px;
        padding: 7px 9px;
        border-radius: 4px;
        background: transparent;
        color: var(--text);
        font: inherit;
        text-align: left;
    }

    .quality-option.active:not(:disabled), .quality-option:hover:not(:disabled) {
        background: var(--panel-raised);
    }

    .quality-option[aria-selected="true"] {
        color: var(--accent-light);
    }

    .quality-option:disabled {
        color: var(--quiet);
        opacity: 1;
    }

    .quality-check {
        display: flex;
        flex: 0 0 14px;
    }
</style>
