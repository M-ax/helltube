<script>
    export let title;
    export let opacity = 0.8;
    function set(value) { opacity = Math.round(Math.max(0.1, Math.min(1, value)) * 100) / 100; }
    function scroll(event) { if (event.deltaY) set(opacity - Math.sign(event.deltaY) * 0.05); }
    function key(event) {
        const delta = {ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05}[event.key];
        if (delta || event.key === 'Home' || event.key === 'End') {
            event.preventDefault(); event.stopPropagation();
            set(event.key === 'Home' ? 0.1 : event.key === 'End' ? 1 : opacity + delta);
        }
    }
</script>

<div class="thumbnail-tools">
    <div class="thumbnail-opacity" role="slider" tabindex="0" aria-label={`Opacity for ${title}`}
         aria-valuemin="10" aria-valuemax="100" aria-valuenow={Math.round(opacity * 100)}
         aria-valuetext={`${Math.round(opacity * 100)}% opaque`} title={`Opacity ${Math.round(opacity * 100)}% · scroll to adjust`}
         on:wheel|nonpassive|preventDefault|stopPropagation={scroll} on:keydown={key}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle class="track" cx="12" cy="12" r="8"/>
            <circle class="progress" cx="12" cy="12" r="8" pathLength="100" stroke-dasharray={`${opacity * 100} 100`}/>
        </svg>
    </div>
</div>
<button class="thumbnail-resize" type="button" data-thumbnail-resize aria-label={`Resize thumbnail for ${title}`}
        title="Drag to resize · arrow keys adjust size">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16 16 4M9 16 16 9M14 16 16 14"/></svg>
</button>

<style>
    .thumbnail-tools, .thumbnail-resize { opacity: 0; pointer-events: none; }
    :global(.floating-thumbnail:is(:hover, :has(:focus-visible), .thumbnail-dragging)) .thumbnail-tools,
    :global(.floating-thumbnail:is(:hover, :has(:focus-visible), .thumbnail-dragging)) .thumbnail-resize {
        opacity: 1; pointer-events: auto;
    }
    @media (hover: none) { .thumbnail-tools, .thumbnail-resize { opacity: 1; pointer-events: auto; } }
    .thumbnail-tools { position: absolute; top: 3px; right: 3px; z-index: 5; }
    .thumbnail-opacity { width: 28px; height: 28px; border-radius: 50%; background: #000c; cursor: ns-resize; color: white; }
    svg { display: block; width: 100%; height: 100%; }
    .thumbnail-opacity svg { transform: rotate(-90deg); }
    circle { fill: none; stroke-width: 3; }
    .track { stroke: #ffffff38; }
    .progress { stroke: var(--accent); }
    .thumbnail-resize { position: absolute; right: 0; bottom: 0; z-index: 5; width: 20px; height: 20px;
        padding: 0; border: 0; background: transparent; color: white; cursor: nwse-resize; touch-action: none; }
    .thumbnail-resize path { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
    .thumbnail-opacity:focus-visible, .thumbnail-resize:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
