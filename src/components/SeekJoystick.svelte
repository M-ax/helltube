<script>
    import {onDestroy} from 'svelte';

    export let disabled = false;
    export let onSeek;
    export let onPreview;
    export let ariaLabel = 'Relative seek joystick';
    export let commitLabel = 'seek for everyone';
    let stick;
    let offset = 0;
    let returnOffset = 0;
    let returning = false;
    let returnSequence = 0;
    let pointerId = null;
    let keyboardActive = false;
    let center = 0;
    let travel = 1;

    $: active = pointerId !== null || keyboardActive;
    $: label = offset ? `${offset > 0 ? '+' : '−'}${Math.abs(offset)}s` : '±30s';
    $: valueText = offset ? `${offset} seconds; release to ${commitLabel}`
        : commitLabel === 'seek for everyone' ? 'Centered; drag to seek up to 30 seconds'
            : `Centered; drag to ${commitLabel} by up to 30 seconds`;
    $: if (disabled) reset();

    function reset() {
        if (disabled) returning = false;
        else if (offset) {
            returnOffset = offset / 30;
            returning = true;
            returnSequence += 1;
        }
        const captured = pointerId;
        pointerId = null;
        keyboardActive = false;
        offset = 0;
        onPreview?.(null);
        if (captured !== null && stick?.hasPointerCapture(captured)) stick.releasePointerCapture(captured);
    }

    function commit() {
        const seconds = offset;
        try {
            if (!disabled && seconds) onSeek(seconds);
        } finally {
            reset();
        }
    }

    function move(event) {
        if (event.pointerId !== pointerId) return;
        offset = Math.round(Math.max(-1, Math.min(1, (event.clientX - center) / travel)) * 30);
        onPreview?.(offset);
    }

    function start(event) {
        if (disabled || event.button !== 0 || !event.isPrimary || pointerId !== null) return;
        event.preventDefault();
        stick.focus();
        returning = false;
        const bounds = stick.getBoundingClientRect();
        center = bounds.left + bounds.width / 2;
        travel = Math.max(1, bounds.width / 2 - 14);
        keyboardActive = false;
        pointerId = event.pointerId;
        stick.setPointerCapture(pointerId);
        move(event);
    }

    function release(event) {
        if (event.pointerId !== pointerId) return;
        move(event);
        commit();
    }

    function cancelPointer(event) {
        if (event.pointerId === pointerId) reset();
    }

    function keydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            reset();
            return;
        }
        if (disabled || pointerId !== null) return;
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            returning = false;
            keyboardActive = true;
            const direction = ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1;
            offset = event.key === 'Home' ? -30 : event.key === 'End' ? 30
                : Math.max(-30, Math.min(30, offset + direction * (event.shiftKey ? 5 : 1)));
            onPreview?.(offset);
        }
    }

    function keyup(event) {
        if (keyboardActive && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            commit();
        }
    }

    onDestroy(() => onPreview?.(null));
</script>

<svelte:window on:blur={reset}/>

<div class="seek-joystick" class:disabled>
    <button bind:this={stick} type="button" class="joystick-track" class:active role="slider"
            {disabled} aria-label={ariaLabel} aria-valuemin={-30} aria-valuemax={30}
            aria-valuenow={offset} aria-valuetext={valueText}
            title={`Drag left or right, release to ${commitLabel}. Arrow keys: 1s; Shift: 5s; Escape: cancel.`}
            style={`--offset: ${offset / 30}; --return-offset: ${returnOffset}`}
            on:pointerdown={start} on:pointermove={move} on:pointerup={release}
            on:pointercancel={cancelPointer} on:lostpointercapture={cancelPointer}
            on:keydown={keydown} on:keyup={keyup} on:blur={reset}>
        <span class="joystick-limit" aria-hidden="true">−</span>
        {#key returnSequence}
            <span class="joystick-knob" class:returning aria-hidden="true" on:animationend={() => returning = false}></span>
        {/key}
        <span class="joystick-limit" aria-hidden="true">+</span>
    </button>
    <span class="joystick-offset" aria-hidden="true">{label}</span>
</div>

<style>
    .seek-joystick {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        margin-left: 10px;
    }

    .disabled {
        opacity: .4;
    }

    .joystick-track {
        position: relative;
        display: flex;
        justify-content: space-between;
        align-items: center;
        box-sizing: border-box;
        flex: 0 0 108px;
        width: 108px;
        height: 30px;
        padding: 0 8px;
        border: 1px solid #44343e;
        border-radius: 20px;
        background: radial-gradient(ellipse at center, #49352b, #211c22 70%);
        box-shadow: inset 0 2px 6px #0008;
        cursor: grab;
        touch-action: none;
        user-select: none;
    }

    .joystick-track.active {
        cursor: grabbing;
        border-color: var(--accent);
    }

    .joystick-track:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 3px;
    }

    .joystick-limit {
        color: #a394a2;
        font: 11px var(--mono);
    }

    .joystick-knob {
        position: absolute;
        left: calc(50% - 11px);
        box-sizing: border-box;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: 1px solid #ffc598;
        background: radial-gradient(circle at 35% 25%, #ffd1a8, var(--accent) 55%, #a04d30);
        box-shadow: 0 3px 6px #0009, inset 0 1px 2px #fff6;
        transform: translateX(calc(var(--offset) * 40px));
        pointer-events: none;
    }

    .joystick-knob.returning {
        animation: joystick-return 380ms ease-in-out;
    }

    @keyframes joystick-return {
        0% { transform: translateX(calc(var(--return-offset) * 40px)); }
        25% { transform: translateX(calc(var(--return-offset) * -12.8px)); }
        50% { transform: translateX(calc(var(--return-offset) * 4.8px)); }
        73% { transform: translateX(calc(var(--return-offset) * -1.6px)); }
        90% { transform: translateX(calc(var(--return-offset) * .4px)); }
        100% { transform: translateX(0); }
    }

    .joystick-offset {
        flex: 0 0 4ch;
        text-align: left;
        white-space: nowrap;
        color: var(--accent);
        font: 9px var(--mono);
        font-variant-numeric: tabular-nums;
    }

    @media (prefers-reduced-motion: reduce) {
        .joystick-knob.returning {
            animation: none;
        }
    }
</style>