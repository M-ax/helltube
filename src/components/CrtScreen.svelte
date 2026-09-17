<script>
    import {onMount} from 'svelte';
    import {startupRows, terminalBar} from '../lib/player-startup.js';

    export let username = 'guest';
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
    const commands = [
        'sudo pacman -S emotional-support',
        'sudo systemctl restart brain.service',
        "git commit -m 'it got worse'",
        'ping -c 4 void.local',
        "find ~/ -name 'will-to-live'",
        'chmod +x ./bad-ideas.sh',
        'tail -f /var/log/brainrot.log',
        'rsync -av ~/memes/ moon:/backup/',
        "grep -R 'skill issue' /var/log",
        'sudo modprobe common_sense',
        'cat /etc/skill-issue',
        'journalctl -u toaster.service -f',
        "uptime && echo 'unfortunately'",
    ];
    let typedCommand = '';

    onMount(() => {
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const delay = (min, max) => min + Math.random() * (max - min);
        let commandIndex = Math.floor(Math.random() * commands.length);
        let deleting = false;
        let timer;

        function type() {
            const command = commands[commandIndex];
            if (deleting) {
                typedCommand = typedCommand.slice(0, -1);
                if (!typedCommand) {
                    // Pick a new command without repeating the one just erased.
                    const next = Math.floor(Math.random() * (commands.length - 1));
                    commandIndex = next >= commandIndex ? next + 1 : next;
                    deleting = false;
                    timer = setTimeout(type, delay(500, 1100));
                    return;
                }
                timer = setTimeout(type, delay(22, 45));
            } else {
                typedCommand = command.slice(0, typedCommand.length + 1);
                deleting = typedCommand === command;
                timer = setTimeout(type, deleting ? delay(1800, 2800)
                    : typedCommand.endsWith(' ') ? delay(130, 260) : delay(45, 115));
            }
        }

        function syncAnimation() {
            clearTimeout(timer);
            if (motion.matches) {
                typedCommand = commands[commandIndex];
                deleting = true;
            } else if (!document.hidden) {
                timer = setTimeout(type, delay(500, 900));
            }
        }

        syncAnimation();
        motion.addEventListener('change', syncAnimation);
        document.addEventListener('visibilitychange', syncAnimation);
        return () => {
            clearTimeout(timer);
            motion.removeEventListener('change', syncAnimation);
            document.removeEventListener('visibilitychange', syncAnimation);
        };
    });

    function shutoff() {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return {duration: 0};
        return {
            duration: 220,
            css: (_t, elapsed) => {
                // Collapse to a phosphor line, then pinch it away over the decoded frame.
                const collapse = Math.min(1, elapsed / .55);
                const pinch = Math.max(0, (elapsed - .55) / .45);
                const height = 1 - .992 * (1 - (1 - collapse) ** 2);
                return `transform: scale(${1 - pinch ** 2}, ${height}); opacity: ${1 - elapsed};
                    filter: brightness(${1 + elapsed * 2}); --crt-flash: ${Math.max(0, Math.min(1, (elapsed - .4) * 5))};
                    pointer-events: none;`;
            },
        };
    }
</script>

<div class="crt-screen" class:crt-active={active} data-stage={item?.preparation?.stage || pending?.stage || 'idle'}
     out:shutoff|global>
    <div class="crt-glass" aria-hidden="true"></div>
    <div class="crt-sweep-vignette" aria-hidden="true">
        <div class="crt-sweep"></div>
    </div>
    <div class="crt-content">
        <div class="crt-titlebar" aria-hidden="true">
            <span class="crt-tab"><span class="crt-icon">&#xf120;</span> 01 <span>~/helltube</span></span>
            <span class="crt-session"><span class:crt-online={connected}>●</span> {connected ? 'attached' : 'reconnecting'} <span class="crt-shell">zsh</span></span>
        </div>
        <div class="crt-fetch">
            <div class="crt-distro" aria-hidden="true">
                <span class="crt-arch crt-icon">&#xf303;</span>
                <span>arch btw</span>
                <div class="crt-palette"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
            </div>
            <div class="crt-output">
                <div class="crt-heading">
                    <span class="crt-kicker">HELLTUBE // VIDEO TERMINAL</span>
                    <h2>{heading}</h2>
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
            </div>
        </div>
        <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</p>
        <div class="crt-prompt">
            <div class="crt-prompt-context" aria-hidden="true">
                <span class="crt-prompt-user"><span class="crt-icon">&#xf303;</span> <span class="crt-identity">{username}@helltube</span></span>
                <span class="crt-powerline crt-icon">&#xe0b0;</span>
                <span class="crt-prompt-path"><span class="crt-icon">&#xf115;</span> ~</span>
                <span class="crt-powerline crt-path-end crt-icon">&#xe0b0;</span>
            </div>
            <div class="crt-input" aria-hidden="true">
                <span class="crt-command">{typedCommand}</span><span class="crt-block-cursor crt-cursor">▌</span>
            </div>
            {#if failed && item}
                <button disabled={!connected} on:click={onSkip} aria-label="Skip this video">skip_video <span aria-hidden="true">↵</span></button>
            {:else if !active || failed}
                <button disabled={!connected} on:click={onAdd} aria-label="Add something good">add_video <span aria-hidden="true">↵</span></button>
            {/if}
        </div>
        {#if item?.kind === 'upload' && !item.media && !failed}
            <p class="crt-note">Some files need the complete upload before playback can start.</p>
        {/if}
    </div>
</div>

<style>
    @font-face {
        font-family: 'Hack Nerd Font Mono';
        src: url('../assets/fonts/HackNerdFontMono-Regular.woff2') format('woff2');
        font-weight: 400;
        font-style: normal;
        font-display: swap;
    }
    .crt-screen {
        --phosphor: var(--accent);
        --terminal-text: #e3c49e;
        --terminal-muted: #ab8d74;
        --terminal-green: #b4bc88;
        --terminal-blue: #91b5b6;
        position: absolute;
        inset: 0;
        isolation: isolate;
        width: 100%;
        min-height: 0;
        display: flex;
        align-items: center;
        padding: 64px clamp(20px, 5.5%, 60px) calc(var(--controls-height) + 24px);
        overflow: hidden;
        transform-origin: center;
        color: var(--phosphor);
        background: radial-gradient(ellipse at 50% 42%, color-mix(in srgb, var(--phosphor) 9%, #080706), #080706 75%);
        font: 13px/1.5 'Hack Nerd Font Mono', var(--mono);
        text-shadow: 0 0 3px color-mix(in srgb, var(--phosphor) 18%, transparent),
            0 0 11px color-mix(in srgb, var(--phosphor) 42%, transparent);
        box-shadow: inset 0 0 80px 18px #000b, inset 0 0 2px 1px color-mix(in srgb, var(--phosphor) 28%, transparent);
    }
    .crt-glass {
        position: absolute;
        inset: 0;
        z-index: 3;
        pointer-events: none;
        background: repeating-linear-gradient(0deg, #0003 0, #0003 1px, transparent 1px, transparent 3px),
            radial-gradient(ellipse at 50% 50%, transparent 40%, #0008 100%);
        border-radius: 20px / 12px;
        box-shadow: inset 0 0 28px #0009;
    }
    .crt-screen::after {
        content: '';
        position: absolute;
        inset: 0;
        z-index: 4;
        pointer-events: none;
        opacity: var(--crt-flash, 0);
        background: linear-gradient(90deg, transparent, var(--phosphor) 25%, #fff3de 50%, var(--phosphor) 75%, transparent);
    }
    .crt-sweep-vignette {
        position: absolute;
        inset: 0;
        z-index: 2;
        pointer-events: none;
        /* Keep the falloff fixed to the screen as the sweep travels through it. */
        mask-image: linear-gradient(to bottom, #0002, #0009 25%, #000 50%, #0009 75%, #0002),
            linear-gradient(to right, #0002, #0009 20%, #000 40%, #000 60%, #0009 80%, #0002);
        mask-composite: intersect;
    }
    .crt-sweep {
        position: absolute;
        top: -25%;
        left: 0;
        right: 0;
        height: 25%;
        background: linear-gradient(transparent, color-mix(in srgb, var(--phosphor) 7%, transparent) 90%, color-mix(in srgb, var(--phosphor) 23%, transparent));
        animation: crt-sweep 7s linear infinite;
    }
    .crt-sweep::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 1px;
        background: color-mix(in srgb, var(--phosphor) 55%, transparent);
        box-shadow: 0 0 3px color-mix(in srgb, var(--phosphor) 38%, transparent),
            0 0 11px color-mix(in srgb, var(--phosphor) 42%, transparent);
    }
    /* Include the Powerline font's descenders in the content height. */
    .crt-content { position: relative; z-index: 1; width: 100%; min-width: 0; height: fit-content; max-height: 100%; padding-bottom: 3px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    .crt-icon { font-family: 'Hack Nerd Font Mono', var(--mono); }
    .crt-titlebar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 24px; border-bottom: 1px solid #ff975e24; font-size: 10px; color: var(--terminal-muted); }
    .crt-tab { display: inline-flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--phosphor); background: #ff975e0d; color: var(--phosphor); }
    .crt-tab > span:last-child { color: var(--terminal-text); }
    .crt-session { display: flex; gap: 8px; align-items: center; }
    .crt-online { color: var(--terminal-green); }
    .crt-shell { margin-left: 10px; padding: 2px 8px; border: 1px solid #ff975e24; }
    .crt-fetch { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 28px; align-items: center; }
    .crt-distro { display: flex; flex-direction: column; align-items: center; gap: 12px; font-size: 10px; color: var(--terminal-muted); }
    .crt-arch { font-size: 112px; line-height: 1; color: var(--phosphor); text-shadow: 0 0 24px #ff975e30; }
    .crt-palette { display: flex; margin-top: 3px; }
    .crt-palette i { width: 12px; height: 9px; background: #44352d; }
    .crt-palette i:nth-child(2) { background: #cc7767; }
    .crt-palette i:nth-child(3) { background: var(--terminal-green); }
    .crt-palette i:nth-child(4) { background: #e4bb78; }
    .crt-palette i:nth-child(5) { background: var(--terminal-blue); }
    .crt-palette i:nth-child(6) { background: #b69bb5; }
    .crt-palette i:nth-child(7) { background: var(--phosphor); }
    .crt-palette i:nth-child(8) { background: var(--terminal-text); }
    .crt-output { min-width: 0; }
    .crt-kicker { font-size: 9px; letter-spacing: .14em; color: var(--terminal-muted); }
    h2 { margin: 7px 0 5px; font: inherit; font-size: clamp(28px, 3.2vw, 40px); line-height: 1.15; letter-spacing: .025em; }
    .crt-active h2 { font-size: clamp(24px, 2.7vw, 32px); }
    .crt-cursor { animation: crt-cursor 1.15s step-end infinite; }
    .crt-source { margin: 0; font-size: 11px; color: var(--terminal-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crt-log { display: grid; gap: 5px; margin-top: 18px; color: var(--terminal-text); }
    .crt-row { display: flex; gap: 12px; align-items: baseline; }
    .crt-code { display: inline-flex; flex: 0 0 auto; gap: 3px; font-size: 11px; color: var(--terminal-green); }
    .crt-code > span { display: inline-block; width: 4ch; text-align: center; }
    .crt-entry { min-width: 0; overflow-wrap: anywhere; }
    .crt-waiting, .crt-waiting .crt-code { color: var(--terminal-muted); }
    .crt-running .crt-code { color: var(--phosphor); }
    .crt-error, .crt-error .crt-code { color: var(--danger); }
    .crt-progress { display: flex; flex-wrap: wrap; gap: 0 10px; align-items: center; font-size: 11px; line-height: 1.6; }
    .crt-meter { white-space: pre; letter-spacing: 0; }
    .crt-percent { min-width: 4ch; text-align: right; }
    .crt-detail { color: var(--accent-light); opacity: .8; }
    .crt-indeterminate > span { position: relative; display: inline-block; overflow: hidden; vertical-align: bottom; }
    .crt-indeterminate > span::after { content: '████'; position: absolute; left: -4ch; animation: crt-working 1.7s linear infinite; }
    .crt-prompt { display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr) auto; gap: 8px 10px; align-items: center; margin-top: 22px; font-size: 11px; }
    .crt-prompt-context { display: flex; align-items: stretch; min-width: 0; max-width: min(36ch, 45cqw); height: 26px; text-shadow: none; }
    .crt-prompt-user, .crt-prompt-path { display: inline-flex; align-items: center; gap: 9px; padding: 0 10px; }
    .crt-prompt-user { min-width: 0; color: #17110d; background: var(--phosphor); }
    .crt-identity { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crt-prompt-user > .crt-icon { flex-shrink: 0; }
    .crt-powerline { display: inline-flex; flex-shrink: 0; align-items: center; font-size: 26px; line-height: 1; color: var(--phosphor); background: #463329; }
    .crt-prompt-path { flex-shrink: 0; padding-left: 6px; color: var(--terminal-text); background: #463329; }
    .crt-path-end { color: #463329; background: transparent; }
    .crt-input { display: flex; align-items: center; min-width: 0; overflow: hidden; }
    .crt-command { min-width: 0; overflow: hidden; white-space: pre; color: var(--terminal-text); }
    .crt-block-cursor { flex-shrink: 0; color: var(--phosphor); }
    .crt-prompt button { padding: 5px 9px; border: 1px solid #ff975e40; border-radius: 2px; color: var(--terminal-green); background: #ff975e09; font: inherit; text-shadow: inherit; }
    .crt-prompt button:hover:not(:disabled) { color: #080706; background: var(--phosphor); }
    .crt-prompt button > span { margin-left: 12px; }
    .crt-note { margin: 10px 0 0; font-size: 10px; color: var(--accent-light); opacity: .8; }
    @keyframes crt-sweep { to { transform: translateY(500%); } }
    @keyframes crt-cursor { 50% { opacity: 0; } }
    @keyframes crt-working { to { transform: translateX(24ch); } }
    @container (max-width: 600px) {
        .crt-screen { font-size: 12px; padding: 44px 16px calc(var(--controls-height) + 10px); }
        .crt-titlebar, .crt-distro { display: none; }
        .crt-fetch { display: block; min-width: 0; }
        .crt-row { gap: 8px; }
        .crt-log { gap: 6px; margin-top: 16px; }
        .crt-progress { gap: 0 7px; font-size: 10px; }
        .crt-detail { flex-basis: 100%; }
        .crt-kicker { font-size: 9px; }
        .crt-prompt { grid-template-columns: minmax(0, max-content) minmax(0, 1fr); }
        .crt-prompt button { grid-column: 1 / -1; justify-self: start; }
        .crt-screen:not(.crt-active) { padding-top: 36px; padding-bottom: calc(var(--controls-height) + 2px); }
        .crt-screen:not(.crt-active) .crt-content { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; padding-bottom: 0; }
        .crt-screen:not(.crt-active) .crt-kicker,
        .crt-screen:not(.crt-active) .crt-source,
        .crt-screen:not(.crt-active) .crt-log,
        .crt-screen:not(.crt-active) .crt-prompt-context { display: none; }
        .crt-screen:not(.crt-active) h2 { margin: 0; font-size: clamp(18px, 5cqw, 28px); white-space: nowrap; }
        .crt-screen:not(.crt-active) .crt-prompt { display: contents; font-size: 10px; }
        .crt-screen:not(.crt-active) .crt-input { grid-column: 1 / -1; grid-row: 2; }
        .crt-screen:not(.crt-active) .crt-prompt button { grid-column: 2; grid-row: 1; }
        .crt-screen:not(.crt-active) .crt-prompt button > span { margin-left: 4px; }
    }
    @media (prefers-reduced-motion: reduce) {
        .crt-sweep { animation: none; display: none; }
        .crt-cursor, .crt-indeterminate > span::after { animation: none; }
        .crt-indeterminate > span::after { left: 8ch; }
    }
</style>
