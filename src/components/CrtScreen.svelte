<script>
    import {startupRows, terminalBar} from '../lib/player-startup.js';

    export let item = null;
    export let pending = null;
    export let connected = false;
    export let onAdd;
    export let onSkip;

    $: rows = startupRows(item, pending, connected);
    $: active = !!item || !!pending;
    $: failed = item ? item.status === 'error' : !!pending?.error;
    $: heading = !connected ? 'LINK LOST' : failed ? 'SIGNAL FAILED' : active ? 'BOOTING STREAM' : 'NO SIGNAL';
    $: status = !connected ? 'Reconnecting to the room.' : failed ? (item?.error || pending?.error)
        : rows.find(row => row.state === 'busy')?.label || 'Awaiting video input.';
    const labels = {ok: 'OK', busy: 'RUN', wait: 'WAIT', halt: 'HALT', fail: 'FAIL'};
</script>

<div class="crt-screen" class:crt-active={active} data-stage={item?.preparation?.stage || pending?.stage || 'idle'}>
    <div class="crt-glass" aria-hidden="true"></div>
    <div class="crt-sweep" aria-hidden="true"></div>
    <div class="crt-content">
        <div class="crt-heading">
            <span class="crt-kicker">HELLTUBE // VIDEO TERMINAL</span>
            <h2>{heading}<span class="crt-cursor" aria-hidden="true">_</span></h2>
            <p class="crt-source">{item?.title || pending?.title || (active ? 'Initializing media pipeline' : 'The next transmission is yours.')}</p>
        </div>
        <div class="crt-log" aria-label="Video startup status">
            {#each rows as row (row.id)}
                <div class="crt-row" class:crt-running={row.state === 'busy'} class:crt-error={row.state === 'fail'} class:crt-waiting={row.state === 'wait'}>
                    <span class="crt-code">[<span>{labels[row.state]}</span>]</span>
                    <div class="crt-entry">
                        <span>{row.label}</span>
                        {#if row.progress !== undefined && row.state !== 'wait' && row.state !== 'halt'}
                            <div class="crt-progress" role="progressbar" aria-label={row.label}
                                 aria-valuemin="0" aria-valuemax="100" aria-valuenow={row.progress ?? undefined}
                                 aria-valuetext={row.progress === null ? 'In progress' : `${row.progress}%${row.detail ? `, ${row.detail}` : ''}`}>
                                {#if row.progress === null}
                                    <span class="crt-meter crt-indeterminate" aria-hidden="true">[<span>░░░░░░░░░░░░░░░░░░░░</span>]</span>
                                    <span class="crt-percent">WORK</span>
                                {:else}
                                    <span class="crt-meter" aria-hidden="true">[{terminalBar(row.progress)}]</span>
                                    <span class="crt-percent">{row.progress}%</span>
                                {/if}
                                {#if row.detail}<span class="crt-detail" aria-hidden="true">{row.detail}</span>{/if}
                            </div>
                        {/if}
                    </div>
                </div>
            {/each}
        </div>
        <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</p>
        <div class="crt-prompt">
            <span aria-hidden="true">guest@helltube:~$</span>
            {#if failed && item}
                <button disabled={!connected} on:click={onSkip} aria-label="Skip this video">skip_video <span aria-hidden="true">↵</span></button>
            {:else if !active || failed}
                <button disabled={!connected} on:click={onAdd} aria-label="Add something good">add_video <span aria-hidden="true">↵</span></button>
            {:else}
                <span>{!connected ? 'waiting for connection' : 'stream --wait'}</span>
            {/if}
        </div>
        {#if item?.kind === 'upload' && !item.media && !failed}
            <p class="crt-note">Some files need the complete upload before playback can start.</p>
        {/if}
    </div>
</div>

<style>
    .crt-screen {
        --phosphor: var(--accent);
        position: relative;
        isolation: isolate;
        width: 100%;
        min-height: 420px;
        align-self: stretch;
        display: flex;
        align-items: center;
        padding: 64px clamp(20px, 5.5%, 60px) calc(var(--controls-height) + 24px);
        overflow: hidden;
        color: var(--phosphor);
        background: radial-gradient(ellipse at 50% 42%, color-mix(in srgb, var(--phosphor) 9%, #080706), #080706 75%);
        font: 15px/1.4 'Share Tech Mono', var(--mono);
        text-shadow: 0 0 9px color-mix(in srgb, var(--phosphor) 30%, transparent);
        box-shadow: inset 0 0 80px 18px #000b, inset 0 0 2px 1px color-mix(in srgb, var(--phosphor) 28%, transparent);
    }
    .crt-glass {
        position: absolute;
        inset: 0;
        z-index: 2;
        pointer-events: none;
        background: repeating-linear-gradient(0deg, #0003 0, #0003 1px, transparent 1px, transparent 3px),
            radial-gradient(ellipse at 50% 50%, transparent 40%, #0008 100%);
        border-radius: 20px / 12px;
        box-shadow: inset 0 0 28px #0009;
    }
    .crt-sweep {
        position: absolute;
        z-index: 3;
        pointer-events: none;
        top: -25%;
        left: 0;
        right: 0;
        height: 25%;
        background: linear-gradient(transparent, color-mix(in srgb, var(--phosphor) 7%, transparent) 90%, color-mix(in srgb, var(--phosphor) 23%, transparent));
        border-bottom: 1px solid color-mix(in srgb, var(--phosphor) 40%, transparent);
        animation: crt-sweep 7s linear infinite;
    }
    .crt-content { position: relative; z-index: 1; width: 100%; min-width: 0; }
    .crt-kicker { font-size: 10px; letter-spacing: .19em; opacity: .75; }
    h2 { margin: 5px 0 3px; font: inherit; font-size: clamp(30px, 3.6vw, 46px); line-height: 1.1; letter-spacing: .07em; }
    .crt-active h2 { font-size: clamp(25px, 3vw, 36px); }
    .crt-cursor { animation: crt-cursor 1.15s step-end infinite; }
    .crt-source { margin: 0; font-size: 12px; color: var(--accent-light); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crt-log { display: grid; gap: 5px; margin-top: 20px; }
    .crt-row { display: flex; gap: 12px; align-items: baseline; }
    .crt-code { display: inline-flex; flex: 0 0 auto; gap: 3px; font-size: 12px; }
    .crt-code > span { display: inline-block; width: 4ch; text-align: center; }
    .crt-entry { min-width: 0; overflow-wrap: anywhere; }
    .crt-waiting { color: color-mix(in srgb, var(--phosphor) 67%, #30241c); }
    .crt-running .crt-code { color: var(--accent-light); }
    .crt-error { color: var(--danger); }
    .crt-progress { display: flex; flex-wrap: wrap; gap: 0 10px; align-items: center; font-size: 11px; line-height: 1.6; }
    .crt-meter { white-space: pre; letter-spacing: 0; }
    .crt-percent { min-width: 4ch; text-align: right; }
    .crt-detail { color: var(--accent-light); opacity: .8; }
    .crt-indeterminate > span { position: relative; display: inline-block; overflow: hidden; vertical-align: bottom; }
    .crt-indeterminate > span::after { content: '████'; position: absolute; left: -4ch; animation: crt-working 1.7s linear infinite; }
    .crt-prompt { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-top: 20px; font-size: 12px; }
    .crt-prompt > span:first-child { opacity: .7; }
    .crt-prompt button { padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--phosphor) 50%, transparent); border-radius: 2px; color: var(--phosphor); background: color-mix(in srgb, var(--phosphor) 7%, transparent); font: inherit; text-shadow: inherit; }
    .crt-prompt button:hover:not(:disabled) { color: #080706; background: var(--phosphor); }
    .crt-prompt button > span { margin-left: 12px; }
    .crt-note { margin: 10px 0 0; font-size: 10px; color: var(--accent-light); opacity: .8; }
    :global(.player-shell:fullscreen) .crt-screen { min-height: 0; height: 100%; overflow-y: auto; align-items: safe center; }
    @keyframes crt-sweep { to { transform: translateY(500%); } }
    @keyframes crt-cursor { 50% { opacity: 0; } }
    @keyframes crt-working { to { transform: translateX(24ch); } }
    @media (max-width: 600px) {
        .crt-screen { min-height: 390px; font-size: 13px; padding-left: 20px; padding-right: 20px; }
        .crt-row { gap: 8px; }
        .crt-log { gap: 6px; margin-top: 16px; }
        .crt-progress { gap: 0 7px; font-size: 10px; }
        .crt-detail { flex-basis: 100%; }
        .crt-kicker { font-size: 9px; }
    }
    @media (prefers-reduced-motion: reduce) {
        .crt-sweep { animation: none; display: none; }
        .crt-cursor, .crt-indeterminate > span::after { animation: none; }
        .crt-indeterminate > span::after { left: 8ch; }
    }
</style>
