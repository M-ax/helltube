<script>
    import {onMount, onDestroy} from 'svelte';
    import Icon from './Icon.svelte';
    import {SPRAY_TIPS, WHITEBOARD_COLORS, WHITEBOARD_WIDTHS, WHITEBOARD_BATCH, WHITEBOARD_MAX_POINTS,
        WHITEBOARD_INTERVAL, emptyWhiteboard, whiteboardPoint} from '../../shared/whiteboard.js';
    import {whiteboardPath} from '../lib/whiteboard.js';

    import {sprayGeometry} from '../lib/spray.js';

    export let onSpray = () => {};
    export let onUnlock = () => {};
    export let board = emptyWhiteboard();
    export let roomId = null;
    export let userId = null;
    export let connected = false;
    export let enabled = true;
    export let open = false;
    export let expanded = false;
    export let viewport;
    export let controlsHeight = 71;
    export let onCommand;

    const tools = [['spray', 'Spray paint'], ['pen', 'Pen'], ['line', 'Line'], ['arrow', 'Arrow'],
        ['rectangle', 'Rectangle'], ['ellipse', 'Circle'], ['eraser', 'Eraser']];
    const colorNames = ['White', 'Orange', 'Pink', 'Yellow', 'Green', 'Blue', 'Purple'];
    let tool = 'pen';
    let sprayTip = 'fat';
    let cursor = null;
    let sprayTimer;
    let sprayPoint;
    const sprayActivity = new Map();
    let color = WHITEBOARD_COLORS[1];
    let strokeWidth = 4;
    let svg;
    let toggle;
    let panel;
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
    let panelTimer;
    let panelHovered = false;
    let panelKeyboardFocus = false;
    const PANEL_HIDE_DELAY = 3000;

    $: compact = width <= 560;
    $: ready = connected && board.roomId === roomId && !!board.epoch;
    $: reconcile(board, ready);
    $: if ((!ready || !enabled) && open) open = false;
    $: syncMode(open);
    $: shapes = [...board.shapes.filter(shape => !localShapes.some(local => local.id === shape.id)), ...localShapes]
        .filter(shape => !erased.includes(shape.id));
    $: canUndo = shapes.some(shape => shape.userId === userId && shape.complete);

    // Keep the SVG inside the viewport while the mobile controls live below it.
    function drawingLayer(node, target) {
        target?.appendChild(node);
        return {update(next) { next?.appendChild(node); }, destroy() { node.remove(); }};
    }

    function schedulePanelHide() {
        clearTimeout(panelTimer);
        if (expanded && !panelHovered && !panelKeyboardFocus && pointerId === null) {
            panelTimer = setTimeout(() => collapsePanel(), PANEL_HIDE_DELAY);
        }
    }

    function collapsePanel(restoreFocus = false) {
        clearTimeout(panelTimer);
        expanded = false;
        panelHovered = false;
        panelKeyboardFocus = false;
        if (restoreFocus || panel?.contains(document.activeElement)) toggle?.focus({preventScroll: true});
    }

    function showPanel() {
        expanded = true;
        schedulePanelHide();
    }

    function syncMode(active) {
        if (active) showPanel();
        else { finish(); collapsePanel(); }
    }

    function togglePanel() {
        if (!open) open = true;
        else if (expanded) collapsePanel(true);
        else showPanel();
    }

    function trackPanelActivity(node) {
        const listeners = [];
        let destroyed = false;
        function listen(type, handler) {
            node.addEventListener(type, handler);
            listeners.push(() => node.removeEventListener(type, handler));
        }
        function focusChanged() {
            queueMicrotask(() => {
                if (destroyed) return;
                panelKeyboardFocus = expanded && node.contains(document.activeElement)
                    && document.activeElement.matches(':focus-visible');
                schedulePanelHide();
            });
        }
        listen('pointerenter', event => { panelHovered = event.pointerType === 'mouse'; schedulePanelHide(); });
        listen('pointerleave', () => { panelHovered = false; schedulePanelHide(); });
        listen('pointerdown', () => { panelKeyboardFocus = false; schedulePanelHide(); });
        listen('pointermove', schedulePanelHide);
        listen('click', schedulePanelHide);
        listen('keydown', focusChanged);
        listen('focusin', focusChanged);
        listen('focusout', focusChanged);
        return {destroy() { destroyed = true; listeners.forEach(remove => remove()); }};
    }

    function send(action, extra = {}) {
        if (!ready) return false;
        return onCommand({type: 'whiteboard', roomId, epoch: board.epoch, action, ...extra});
    }

    function release() {
        const id = pointerId;
        pointerId = null;
        if (id !== null && svg?.hasPointerCapture(id)) svg.releasePointerCapture(id);
        previousErase = null;
        clearInterval(sprayTimer); sprayTimer = null;
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
        clearTimeout(panelTimer);
        if (!compact) collapsePanel();
        const point = pointAt(event);
        if (tool === 'eraser') { eraseAt(point); return; }
        activeId = globalThis.crypto?.randomUUID?.() || `mark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const shape = {id: activeId, userId, tool, color, width: strokeWidth, tip: sprayTip, points: [point], complete: false};
        if (!send('begin', {id: activeId, tool, color, width: strokeWidth, point, ...(tool === 'spray' ? {tip: sprayTip} : {})})) { activeId = null; release(); return; }
        localShapes = [...localShapes, shape];
        if (tool === 'spray') {
            onUnlock();
            sprayPoint = point; cursor = point;
            sprayTimer = setInterval(sprayTick, WHITEBOARD_INTERVAL);
        }
    }

    function move(event) {
        if (open && tool === 'spray') cursor = pointAt(event);
        if (pointerId !== event.pointerId || !open || !ready) return;
        event.preventDefault(); event.stopPropagation();
        const point = pointAt(event);
        if (tool === 'eraser') { eraseAt(point); return; }
        const shape = localShapes.find(value => value.id === activeId);
        if (!shape) return;
        if (shape.tool === 'spray') { sprayPoint = point; return; }
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

    function sprayTick() {
        const shape = localShapes.find(value => value.id === activeId);
        if (!shape || !open || !ready || document.hidden) { finish(); return; }
        if (shape.points.length >= WHITEBOARD_MAX_POINTS) { finish(); return; }
        localShapes = localShapes.map(value => value.id === activeId ? {...value, points: [...value.points, sprayPoint]} : value);
        pendingPoints.push(sprayPoint);
        flush();
    }

    function end(event) {
        if (event.pointerId !== pointerId) return;
        if (event.type === 'pointerup') move(event);
        finish();
        collapsePanel();
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
    function close() { finish(); open = false; collapsePanel(true); }
    function keydown(event) {
        if (!open) return;
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z'
            && event.target.closest?.('.player-shell') && !event.target.matches('input, textarea')) {
            event.preventDefault(); undo();
        }
    }

    onMount(() => {
        const soundTimer = setInterval(() => {
            const now = performance.now();
            let active = 0;
            const ids = new Set();
            for (const shape of shapes) {
                if (shape.tool !== 'spray' || shape.complete) continue;
                ids.add(shape.id);
                const previous = sprayActivity.get(shape.id);
                // The first snapshot establishes a baseline: never replay old spray sounds on join.
                if (!previous) sprayActivity.set(shape.id, {count: shape.points.length, at: -Infinity});
                else if (previous.count !== shape.points.length) sprayActivity.set(shape.id, {count: shape.points.length, at: now});
                if (now - sprayActivity.get(shape.id).at < 180) active++;
            }
            for (const id of sprayActivity.keys()) if (!ids.has(id)) sprayActivity.delete(id);
            onSpray(enabled && ready && !document.hidden ? Math.min(3, active) : 0);
        }, 40);
        return () => { clearInterval(soundTimer); onSpray(0); };
    });

    onDestroy(() => { finish(); clearTimeout(timer); clearTimeout(panelTimer); });
</script>

<svelte:window on:keydown={keydown} on:blur={() => { finish(); collapsePanel(); }}/>
<svelte:document on:visibilitychange={() => { if (document.hidden) { finish(); collapsePanel(); } }}/>

{#if enabled}
    <div class="whiteboard-layer-mount">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Drawing uses a pointer; tools and undo are keyboard accessible.) -->
    <svg class="whiteboard-canvas" class:drawing={open && ready} class:spraying={tool === 'spray'} class:erasing={tool === 'eraser'}
         bind:this={svg} bind:clientWidth={width} bind:clientHeight={height}
         use:drawingLayer={viewport}
         viewBox={`0 0 ${width || 960} ${height || 540}`} role="img" aria-label="Shared whiteboard" tabindex="-1"
         on:pointerleave={() => { if (pointerId === null) cursor = null; }}
         on:pointerdown={begin} on:pointermove={move} on:pointerup={end} on:pointercancel={end} on:lostpointercapture={end}>
        {#if ready}
            {#each shapes as shape (shape.id)}
                <g data-whiteboard-id={shape.id} data-tool={shape.tool} data-complete={shape.complete}>
                    <title>{shape.author || 'You'} · {shape.tool}</title>
                    {#if shape.tool === 'spray'}
                        {@const paint = sprayGeometry(shape)}
                        <g transform={`scale(${width / 960} ${height / 540})`}>
                            <path d={paint.haze} stroke={shape.color} stroke-width={paint.radius * 1.1 * paint.aspect} opacity=".035" fill="none" stroke-linecap="round"/>
                            <path d={paint.dots} stroke={shape.color} stroke-width="1" opacity=".45" fill="none" stroke-linecap="round"/>
                            {#each paint.drips as drop}
                                <ellipse cx={drop.x} cy={drop.y} rx={paint.radius * .45} ry={paint.radius * .45 * paint.aspect}
                                         fill={shape.color} opacity={Math.min(.7, drop.length / 120)}/>
                                <ellipse cx={drop.x} cy={drop.y} rx={paint.radius * .28} ry={paint.radius * .28 * paint.aspect}
                                         fill={shape.color} opacity={Math.min(.6, drop.length / 100)}/>
                                <path data-spray-drip d={`M${drop.x} ${drop.y}v${drop.length}`} stroke={shape.color} stroke-width={drop.width} stroke-linecap="round"/>
                                <ellipse cx={drop.x} cy={drop.y + drop.length} rx={drop.width * .72} ry={drop.width} fill={shape.color}/>
                            {/each}
                        </g>
                    {:else}
                    <path d={whiteboardPath(shape, width, height)} stroke={shape.color} stroke-width={shape.width}
                          fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                    {/if}
                    {#if open && tool === 'eraser'}
                        {#if shape.tool === 'spray'}
                            {#each sprayGeometry(shape).drips as drop}
                                <path data-hit-id={shape.id} d={`M${drop.x * width / 960} ${drop.y * height / 540}v${drop.length * height / 540}`}
                                      stroke="transparent" stroke-width={Math.max(20, drop.width * width / 960 + 12)} fill="none" stroke-linecap="round"/>
                            {/each}
                        {/if}
                        <path data-hit-id={shape.id} d={whiteboardPath(shape, width, height)} stroke="transparent"
                              stroke-width={shape.tool === 'spray' ? sprayGeometry(shape).radius * 2 * width / 960 : Math.max(20, shape.width + 12)} fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                    {/if}
                </g>
            {/each}
        {/if}
        {#if open && ready && tool === 'spray' && cursor}
            <g class="spray-can" transform={`translate(${cursor[0] * width} ${cursor[1] * height})`} aria-hidden="true">
                <circle r="4" fill="none" stroke={color} opacity=".65"/>
                <g transform="translate(8 5) rotate(-20)">
                    <path d="M3 14Q3 8 9 8H21Q27 8 27 14V53Q27 58 15 58T3 53Z" fill="#c4c5c8" stroke="#242429" stroke-width="1.5"/>
                    <path d="M4 24H26V47H4Z" fill={color}/><path d="M7 25V46" stroke="#fff" opacity=".45" stroke-width="2"/>
                    <path d="M10 8V2H20V8" fill="#33343b" stroke="#eee"/><circle cx="11" cy="4" r="1.5" fill="#111"/>
                    <text x="15" y="38" fill="#19191d" font-size="8" font-weight="900" text-anchor="middle">PSST</text>
                    <path d="M7 52H23" stroke="#777"/>
                </g>
            </g>
        {/if}
    </svg>
    </div>
    <div class="whiteboard-launcher" class:expanded class:compact>
        <button class="whiteboard-toggle" class:active={open} bind:this={toggle} type="button"
                aria-label="Whiteboard tools" aria-expanded={expanded} aria-controls="whiteboard-tools"
                title={expanded ? 'Collapse tools · keep drawing' : open ? 'Show tools · drawing is on' : 'Draw with everyone in the room'} disabled={!ready}
                on:click={togglePanel}>
            <Icon name={open ? tool : 'pen'} size={19}/><span class="toggle-arrow" class:reverse={expanded}><Icon name="chevron" size={10}/></span>
        </button>
        {#if open}<button class="whiteboard-stop" type="button" aria-label="Finish drawing" title="Finish drawing · Escape" on:click={close}>
            <Icon name="close" size={15}/>
        </button>{/if}
    </div>
    <div class="whiteboard-dock" class:compact class:collapsed={!expanded} inert={!expanded} aria-hidden={!expanded}
         style={`--panel-max-height: ${Math.max(100, height - controlsHeight - 64)}px`}>
        <div class="whiteboard-dock-clip">
        <section id="whiteboard-tools" class="whiteboard-tools" aria-label="Whiteboard controls" bind:this={panel} use:trackPanelActivity>
            <header><div><strong>Whiteboard</strong><span class="live"><i></i>LIVE WITH ROOM</span></div>
                <button type="button" class="collapse" aria-label="Collapse whiteboard tools" title="Keep drawing with the tools tucked away"
                        on:click={() => collapsePanel(true)}><Icon name={compact ? 'up' : 'chevron'} size={16}/></button>
            </header>
            <div class="tools" role="group" aria-label="Drawing tools">
                {#each tools as [value, label]}
                    <button type="button" aria-label={label} aria-pressed={tool === value} on:click={() => choose(value)}>
                        <Icon name={value} size={19}/><span>{label}</span>
                    </button>
                {/each}
            </div>
            {#if tool === 'spray'}
                <div class="spray-tips" role="group" aria-label="Spray tips">
                    {#each SPRAY_TIPS as tip}
                        <button type="button" aria-pressed={sprayTip === tip.id} on:click={() => { finish(); sprayTip = tip.id; }}>{tip.label}</button>
                    {/each}
                </div>
            {/if}
            <div class="palette" role="group" aria-label="Ink color">
                {#each WHITEBOARD_COLORS as value, index}
                    <button type="button" class="swatch" style={`--ink: ${value}`} aria-label={`${colorNames[index]} ink`}
                            aria-pressed={color === value} on:click={() => { finish(); color = value; }}><span></span></button>
                {/each}
            </div>
            <div class="tool-footer">
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
            </div>
            <p>{tool === 'spray' ? 'Hold to spray. Linger for wet paint and long drips.' : tool === 'eraser' ? 'Drag across a mark to erase it for everyone.' : 'Draw on the picture. Tools tuck away as you draw.'} <span>Esc to finish.</span></p>
        </section>
        </div>
    </div>
{/if}

<style>
    .whiteboard-layer-mount { display: none; }
    .whiteboard-canvas { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 3; pointer-events: none; overflow: hidden; }
    .whiteboard-canvas.drawing { pointer-events: auto; cursor: crosshair; touch-action: none; user-select: none; }
    .whiteboard-canvas.spraying.drawing { cursor: none; }
    .spray-tips { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 10px; }
    .spray-tips button { padding: 7px 2px; border: 1px solid #ffffff26; border-radius: 5px; font-size: 10px; color: #d2c9c4; }
    .spray-tips button[aria-pressed=true] { border-color: var(--accent); background: var(--accent-dim); }
    .whiteboard-canvas.erasing.drawing { cursor: cell; }
    .whiteboard-canvas:focus { outline: none; }
    .whiteboard-canvas g { pointer-events: none; }
    .whiteboard-launcher { position: absolute; z-index: 6; left: 0; top: 52px; display: grid; gap: 3px; transition: left .2s ease; }
    .whiteboard-launcher.expanded:not(.compact) { left: 216px; }
    .whiteboard-toggle { width: 44px; height: 42px; display: flex; align-items: center; justify-content: center; gap: 2px;
        border: 1px solid #ffffff26; border-left: 0; border-radius: 0 8px 8px 0; background: #19191df2; color: #d2c9c4; box-shadow: 0 3px 12px #0004; }
    .toggle-arrow { display: flex; }
    .toggle-arrow.reverse { transform: rotate(180deg); }
    .whiteboard-stop { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid #ffffff26; border-left: 0;
        border-radius: 0 7px 7px 0; background: #19191df2; color: var(--muted); }
    .whiteboard-toggle.active, .whiteboard-toggle:hover:enabled { color: var(--accent); border-color: var(--accent); background: #32231ff5; }
    .whiteboard-dock { position: absolute; z-index: 6; top: 52px; left: 0; width: 216px;
        transition: transform .2s ease, visibility 0s; }
    .whiteboard-dock.collapsed { transform: translateX(-100%); visibility: hidden; pointer-events: none;
        transition: transform .2s ease, visibility 0s .2s; }
    .whiteboard-tools { max-height: var(--panel-max-height); overflow-y: auto; overscroll-behavior: contain;
        padding: 13px; border: 1px solid #655043; border-left: 0; border-radius: 0 11px 11px 0; background: #19191df7;
        box-shadow: 0 8px 30px #0007; color: var(--text); scrollbar-width: thin; }
    header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
    strong { display: block; font-size: 13px; font-weight: 600; }
    .live { display: flex; gap: 5px; align-items: center; margin-top: 5px; color: var(--green); font: 8px var(--mono); letter-spacing: .06em; }
    .live i { width: 5px; height: 5px; background: var(--green); border-radius: 50%; }
    .collapse { display: grid; place-items: center; width: 28px; height: 28px; color: var(--muted); border-radius: 5px; transform: rotate(180deg); }
    .tools { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
    .tools button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
        min-height: 49px; padding: 7px 2px; border: 1px solid #ffffff13; border-radius: 6px; background: #222226; color: #c4bec8; }
    .tools span { font-size: 9px; }
    .tools button[aria-pressed=true], .sizes button[aria-pressed=true] { border-color: var(--accent); background: var(--accent-dim); color: var(--accent-light); }
    .palette { display: flex; justify-content: space-between; gap: 3px; margin: 14px 0 12px; }
    .swatch { display: grid; place-items: center; width: 23px; height: 25px; padding: 0; }
    .swatch span { width: 21px; height: 21px; border: 3px solid #19191d; border-radius: 50%; background: var(--ink); }
    .swatch[aria-pressed=true] span { box-shadow: 0 0 0 1px var(--ink); }
    .sizes { display: flex; gap: 5px; }
    .sizes button { display: grid; place-items: center; flex: 1; height: 28px; border: 1px solid #ffffff13; border-radius: 5px; color: #d2c9c4; }
    .sizes span { display: block; width: 23px; background: currentColor; border-radius: 8px; }
    .actions { display: flex; justify-content: space-between; gap: 5px; margin-top: 12px; padding-top: 10px; border-top: 1px solid #ffffff13; }
    .actions button { display: flex; align-items: center; gap: 4px; padding: 4px 0; color: #d2c9c4; font-size: 10px; }
    button:hover:enabled { color: var(--accent-light); }
    p { margin: 10px 0 0; font-size: 10px; line-height: 1.5; color: var(--muted); }
    p span { color: var(--quiet); white-space: nowrap; }
    .whiteboard-launcher.compact { top: 40px; display: flex; gap: 0; }
    .compact .whiteboard-stop { height: 42px; border-radius: 0 7px 7px 0; }
    .compact:has(.whiteboard-stop) .whiteboard-toggle { border-radius: 0; }
    .whiteboard-dock.compact { position: relative; top: auto; width: 100%; flex: 0 0 auto; display: grid; grid-template-rows: 1fr;
        transform: none; transition: grid-template-rows .2s ease, visibility 0s; overflow-anchor: none; }
    .whiteboard-dock.compact.collapsed { grid-template-rows: 0fr; transition: grid-template-rows .2s ease, visibility 0s .2s; }
    .compact .whiteboard-dock-clip { min-height: 0; overflow: hidden; }
    .compact .whiteboard-tools { max-height: min(320px, 55dvh); padding: 10px 12px; border: 0; border-top: 1px solid #655043; border-radius: 0; box-shadow: none; }
    .compact header { align-items: center; margin-bottom: 8px; }
    .compact header > div { display: flex; align-items: center; gap: 12px; }
    .compact .live { margin: 0; }
    .compact .collapse { width: 40px; height: 36px; transform: none; }
    .compact .tools { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 3px; }
    .compact .tools button { flex: 1 0 44px; }
    .compact .tools button { min-height: 48px; }
    .compact .palette { justify-content: space-around; margin: 3px 0; }
    .compact .swatch { width: 40px; height: 40px; }
    .compact .swatch span { width: 24px; height: 24px; }
    .compact .tool-footer { display: flex; align-items: center; gap: 12px; }
    .compact .sizes { flex: 1; }
    .compact .sizes button { min-width: 30px; height: 40px; }
    .compact .sizes span { width: 18px; }
    .compact .actions { gap: 12px; margin: 0; padding: 0; border: 0; }
    .compact .actions button { min-height: 40px; }
    .compact p { display: none; }
    :global(.player-shell:fullscreen) .whiteboard-dock.compact, :global(.theater-mode) .whiteboard-dock.compact {
        position: absolute; top: auto; bottom: 0; max-height: 60%; }
    @media (prefers-reduced-motion: reduce) {
        .whiteboard-dock, .whiteboard-dock.compact, .whiteboard-dock.collapsed, .whiteboard-dock.compact.collapsed, .whiteboard-launcher { transition: none; }
    }
</style>
