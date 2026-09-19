<script>
    import {onDestroy} from 'svelte';
    import Icon from './Icon.svelte';
    import {WHITEBOARD_COLORS, WHITEBOARD_WIDTHS, WHITEBOARD_BATCH, WHITEBOARD_MAX_POINTS,
        WHITEBOARD_INTERVAL, emptyWhiteboard, whiteboardPoint} from '../../shared/whiteboard.js';
    import {whiteboardPath} from '../lib/whiteboard.js';

    export let board = emptyWhiteboard();
    export let roomId = null;
    export let userId = null;
    export let connected = false;
    export let enabled = true;
    export let open = false;
    export let onCommand;

    const tools = [['pen', 'Pen'], ['line', 'Line'], ['arrow', 'Arrow'],
        ['rectangle', 'Rectangle'], ['ellipse', 'Circle'], ['eraser', 'Eraser']];
    const colorNames = ['White', 'Orange', 'Pink', 'Yellow', 'Green', 'Blue', 'Purple'];
    let tool = 'pen';
    let color = WHITEBOARD_COLORS[1];
    let strokeWidth = 4;
    let svg;
    let toggle;
    let width = 960;
    let height = 540;
    let pointerId = null;
    let activeId = null;
    let localShapes = [];
    let pendingPoints = [];
    let erased = [];
    let pendingErase = new Set();
    let previousErase = null;
    let timer;
    let context = null;
    let lastError = null;

    $: ready = connected && board.roomId === roomId && !!board.epoch;
    $: reconcile(board, ready);
    $: if ((!ready || !enabled) && open) open = false;
    $: if (!open) finish();
    $: shapes = [...board.shapes.filter(shape => !localShapes.some(local => local.id === shape.id)), ...localShapes]
        .filter(shape => !erased.includes(shape.id));
    $: canUndo = shapes.some(shape => shape.userId === userId && shape.complete);

    function send(action, extra = {}) {
        if (!ready) return false;
        return onCommand({type: 'whiteboard', roomId, epoch: board.epoch, action, ...extra});
    }

    function release() {
        const id = pointerId;
        pointerId = null;
        if (id !== null && svg?.hasPointerCapture(id)) svg.releasePointerCapture(id);
        previousErase = null;
    }

    function reconcile(state, online) {
        const nextContext = online ? `${state.roomId}:${state.epoch}` : null;
        if (context !== nextContext) {
            context = nextContext;
            clearTimeout(timer); timer = null;
            localShapes = []; pendingPoints = []; erased = []; pendingErase.clear(); activeId = null;
            release();
        }
        const error = state.error !== lastError ? state.error : null;
        const rejectedLocal = error?.id && localShapes.some(shape => shape.id === error.id);
        lastError = state.error;
        localShapes = localShapes.flatMap(local => {
            const confirmed = state.shapes.find(shape => shape.id === local.id);
            if (error?.id === local.id || (local.acknowledged && !confirmed)
                || (local.complete && confirmed?.complete)) return [];
            return [{...local, acknowledged: local.acknowledged || !!confirmed}];
        });
        erased = erased.filter(id => state.shapes.some(shape => shape.id === id));
        if (activeId && !localShapes.some(shape => shape.id === activeId)) {
            // An erase or clear from another viewer wins over any queued local points.
            activeId = null; pendingPoints = [];
            clearTimeout(timer); timer = null;
            release();
        }
        if (error) {
            pendingErase.clear(); erased = [];
            if (rejectedLocal) send('end', {id: error.id});
        }
    }

    function schedule() {
        if (!timer) timer = setTimeout(flush, WHITEBOARD_INTERVAL);
    }

    function flush() {
        clearTimeout(timer); timer = null;
        if (activeId && pendingPoints.length) {
            send('draw', {id: activeId, points: pendingPoints});
            pendingPoints = [];
        }
        if (pendingErase.size) {
            send('erase', {ids: [...pendingErase]});
            pendingErase.clear();
        }
    }

    function finish() {
        flush();
        if (activeId) {
            send('end', {id: activeId});
            localShapes = localShapes.map(shape => shape.id === activeId ? {...shape, complete: true} : shape);
            activeId = null;
        }
        release();
    }

    function pointAt(event) {
        const rect = svg.getBoundingClientRect();
        return whiteboardPoint([Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))]);
    }

    function begin(event) {
        if (!open || !ready || event.button !== 0 || event.isPrimary === false || pointerId !== null) return;
        event.preventDefault(); event.stopPropagation();
        pointerId = event.pointerId;
        svg.setPointerCapture(pointerId);
        svg.focus({preventScroll: true});
        const point = pointAt(event);
        if (tool === 'eraser') { eraseAt(point); return; }
        activeId = globalThis.crypto?.randomUUID?.() || `mark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const shape = {id: activeId, userId, tool, color, width: strokeWidth, points: [point], complete: false};
        if (!send('begin', {id: activeId, tool, color, width: strokeWidth, point})) { activeId = null; release(); return; }
        localShapes = [...localShapes, shape];
    }

    function move(event) {
        if (pointerId !== event.pointerId || !open || !ready) return;
        event.preventDefault(); event.stopPropagation();
        const point = pointAt(event);
        if (tool === 'eraser') { eraseAt(point); return; }
        const shape = localShapes.find(value => value.id === activeId);
        if (!shape) return;
        const previous = shape.points.at(-1);
        if (Math.hypot((point[0] - previous[0]) * width, (point[1] - previous[1]) * height) < 1) return;
        if (shape.tool === 'pen' && shape.points.length >= WHITEBOARD_MAX_POINTS) { finish(); return; }
        localShapes = localShapes.map(value => value.id === activeId
            ? {...value, points: tool === 'pen' ? [...value.points, point] : [value.points[0], point]} : value);
        if (tool === 'pen') pendingPoints.push(point);
        else pendingPoints = [point];
        if (pendingPoints.length >= WHITEBOARD_BATCH) flush();
        else schedule();
    }

    function end(event) {
        if (event.pointerId !== pointerId) return;
        if (event.type === 'pointerup') move(event);
        finish();
    }

    function eraseAt(point) {
        const paths = [...svg.querySelectorAll('[data-hit-id]')].reverse();
        const from = previousErase || point;
        const steps = Math.max(1, Math.ceil(Math.hypot((point[0] - from[0]) * width, (point[1] - from[1]) * height) / 8));
        for (let index = 1; index <= steps; index++) {
            const probe = svg.createSVGPoint();
            probe.x = (from[0] + (point[0] - from[0]) * index / steps) * width;
            probe.y = (from[1] + (point[1] - from[1]) * index / steps) * height;
            const hit = paths.find(path => !erased.includes(path.dataset.hitId) && path.isPointInStroke(probe));
            if (!hit) continue;
            erased = [...erased, hit.dataset.hitId];
            pendingErase.add(hit.dataset.hitId);
            if (pendingErase.size >= WHITEBOARD_BATCH) flush();
        }
        previousErase = point;
        if (pendingErase.size) schedule();
    }

    function choose(value) { finish(); tool = value; }
    function undo() { finish(); send('undo'); }
    function clear() { finish(); send('clear'); }
    function close() { finish(); open = false; toggle?.focus({preventScroll: true}); }
    function keydown(event) {
        if (!open) return;
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z'
            && event.target.closest?.('.player-shell') && !event.target.matches('input, textarea')) {
            event.preventDefault(); undo();
        }
    }

    onDestroy(() => { finish(); clearTimeout(timer); });
</script>

<svelte:window on:keydown={keydown} on:blur={finish}/>
<svelte:document on:visibilitychange={() => { if (document.hidden) finish(); }}/>

{#if enabled}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Drawing uses a pointer; tools and undo are keyboard accessible.) -->
    <svg class="whiteboard-canvas" class:drawing={open && ready} class:erasing={tool === 'eraser'}
         bind:this={svg} bind:clientWidth={width} bind:clientHeight={height}
         viewBox={`0 0 ${width || 960} ${height || 540}`} role="img" aria-label="Shared whiteboard" tabindex="-1"
         on:pointerdown={begin} on:pointermove={move} on:pointerup={end} on:pointercancel={end} on:lostpointercapture={end}>
        {#if ready}
            {#each shapes as shape (shape.id)}
                <g data-whiteboard-id={shape.id} data-tool={shape.tool} data-complete={shape.complete}>
                    <title>{shape.author || 'You'} · {shape.tool}</title>
                    <path d={whiteboardPath(shape, width, height)} stroke={shape.color} stroke-width={shape.width}
                          fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                    {#if open && tool === 'eraser'}
                        <path data-hit-id={shape.id} d={whiteboardPath(shape, width, height)} stroke="transparent"
                              stroke-width={Math.max(20, shape.width + 12)} fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                    {/if}
                </g>
            {/each}
        {/if}
    </svg>
    <button class="whiteboard-toggle" class:active={open} bind:this={toggle} type="button"
            aria-label="Whiteboard tools" aria-expanded={open} aria-controls="whiteboard-tools"
            title={open ? 'Close whiteboard · Escape' : 'Draw with everyone in the room'} disabled={!ready}
            on:click={() => open = !open}><Icon name="pen" size={19}/></button>
    {#if open}
        <section id="whiteboard-tools" class="whiteboard-tools" aria-label="Whiteboard controls">
            <header><div><strong>Whiteboard</strong><span class="live"><i></i>LIVE WITH ROOM</span></div>
                <button type="button" class="close" aria-label="Close whiteboard tools" on:click={close}><Icon name="close" size={16}/></button>
            </header>
            <div class="tools" role="group" aria-label="Drawing tools">
                {#each tools as [value, label]}
                    <button type="button" aria-label={label} aria-pressed={tool === value} on:click={() => choose(value)}>
                        <Icon name={value} size={19}/><span>{label}</span>
                    </button>
                {/each}
            </div>
            <div class="palette" role="group" aria-label="Ink color">
                {#each WHITEBOARD_COLORS as value, index}
                    <button type="button" class="swatch" style={`--ink: ${value}`} aria-label={`${colorNames[index]} ink`}
                            aria-pressed={color === value} on:click={() => { finish(); color = value; }}></button>
                {/each}
            </div>
            <div class="sizes" role="group" aria-label="Stroke size">
                {#each WHITEBOARD_WIDTHS as value, index}
                    <button type="button" aria-label={`${['Thin', 'Medium', 'Thick'][index]} stroke`}
                            aria-pressed={strokeWidth === value} on:click={() => { finish(); strokeWidth = value; }}>
                        <span style={`height: ${value}px`}></span>
                    </button>
                {/each}
            </div>
            <div class="actions">
                <button type="button" disabled={!canUndo} on:click={undo} title="Undo your last mark · Ctrl/⌘ Z"><Icon name="undo" size={15}/>Undo mine</button>
                <button type="button" disabled={!shapes.length} on:click={clear} title="Clear the whiteboard for everyone"><Icon name="trash" size={15}/>Clear all</button>
            </div>
            <p>{tool === 'eraser' ? 'Drag across a mark to erase it for everyone.' : 'Draw on the picture. Everyone sees it live.'} <span>Esc to finish.</span></p>
        </section>
    {/if}
{/if}

<style>
    .whiteboard-canvas { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 3; pointer-events: none; overflow: hidden; }
    .whiteboard-canvas.drawing { pointer-events: auto; cursor: crosshair; touch-action: none; user-select: none; }
    .whiteboard-canvas.erasing.drawing { cursor: cell; }
    .whiteboard-canvas:focus { outline: none; }
    .whiteboard-canvas g { pointer-events: none; }
    .whiteboard-toggle { position: absolute; z-index: 6; left: 12px; top: 52px; width: 36px; height: 36px; display: grid;
        place-items: center; border: 1px solid #ffffff26; border-radius: 9px; background: #19191df2; color: #d2c9c4; box-shadow: 0 3px 12px #0004; }
    .whiteboard-toggle.active, .whiteboard-toggle:hover:enabled { color: var(--accent); border-color: var(--accent); background: #32231ff5; }
    .whiteboard-tools { position: absolute; z-index: 6; top: 52px; left: 56px; width: 202px;
        max-height: calc(100% - var(--controls-height) - 64px); overflow-y: auto; overscroll-behavior: contain;
        padding: 13px; border: 1px solid #655043; border-radius: 11px; background: #19191df7; box-shadow: 0 8px 30px #0007;
        color: var(--text); scrollbar-width: thin; animation: reveal .15s ease-out; }
    header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
    strong { display: block; font-size: 13px; font-weight: 600; }
    .live { display: flex; gap: 5px; align-items: center; margin-top: 5px; color: var(--green); font: 8px var(--mono); letter-spacing: .06em; }
    .live i { width: 5px; height: 5px; background: var(--green); border-radius: 50%; }
    .close { display: grid; place-items: center; width: 24px; height: 24px; color: var(--muted); border-radius: 5px; }
    .tools { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
    .tools button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
        min-height: 49px; padding: 7px 2px; border: 1px solid #ffffff13; border-radius: 6px; background: #222226; color: #c4bec8; }
    .tools span { font-size: 9px; }
    .tools button[aria-pressed=true], .sizes button[aria-pressed=true] { border-color: var(--accent); background: var(--accent-dim); color: var(--accent-light); }
    .palette { display: flex; justify-content: space-between; gap: 3px; margin: 14px 0 12px; }
    .swatch { width: 21px; height: 21px; padding: 0; border: 3px solid #19191d; border-radius: 50%; background: var(--ink); }
    .swatch[aria-pressed=true] { box-shadow: 0 0 0 1px var(--ink); }
    .sizes { display: flex; gap: 5px; }
    .sizes button { display: grid; place-items: center; flex: 1; height: 28px; border: 1px solid #ffffff13; border-radius: 5px; color: #d2c9c4; }
    .sizes span { display: block; width: 23px; background: currentColor; border-radius: 8px; }
    .actions { display: flex; justify-content: space-between; gap: 5px; margin-top: 12px; padding-top: 10px; border-top: 1px solid #ffffff13; }
    .actions button { display: flex; align-items: center; gap: 4px; padding: 4px 0; color: #d2c9c4; font-size: 10px; }
    button:hover:enabled { color: var(--accent-light); }
    p { margin: 10px 0 0; font-size: 10px; line-height: 1.5; color: var(--muted); }
    p span { color: var(--quiet); white-space: nowrap; }
    @keyframes reveal { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
    @media (prefers-reduced-motion: reduce) { .whiteboard-tools { animation: none; } }
    @container (max-width: 560px) {
        .whiteboard-toggle { left: 8px; top: 40px; width: 32px; height: 32px; }
        .whiteboard-tools { left: 47px; top: 40px; width: 185px; padding: 10px; max-height: calc(100% - var(--controls-height) - 48px); }
    }
</style>
