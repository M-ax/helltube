<script>
    import FlashbangGrenade from './FlashbangGrenade.svelte';

    export let connected = false;
    export let beachBall = false;
    export let armed = false;
    export let enabled = true;
    export let soundMuted = false;
    export let onReact;
    export let onEnabledToggle;
    export let onSoundToggle;
</script>

<section class="reactions-panel" aria-label="Reactions">
    <div class="reactions-heading">
        <h3>Reactions</h3>
        <span>Shared with everyone here</span>
        <div class="reaction-settings">
            <button class="reaction-toggle" type="button" role="switch" aria-checked={enabled}
                    aria-label="Enable reactions on this device" on:click={onEnabledToggle}>
                <span class="reaction-toggle-track" aria-hidden="true"></span>
                Reactions {enabled ? 'on' : 'off'}
            </button>
            <button class="reaction-sound" type="button" aria-pressed={soundMuted}
                    aria-label="Mute reaction sounds" on:click={onSoundToggle}>
                {soundMuted ? 'Sound off' : 'Sound on'}
            </button>
        </div>
    </div>
    <div class="reaction-buttons">
        <button type="button" class="reaction-button" disabled={!connected || !enabled} aria-pressed={beachBall}
                on:click={() => onReact('beachball')}><span class="beach-ball-icon" aria-hidden="true"></span>Beach ball</button>
        <button type="button" class="reaction-button" disabled={!connected || !enabled} aria-pressed={armed}
                on:click={() => onReact('hitmarker')}>
            <svg class="hitmarker-icon" viewBox="0 0 32 32" aria-hidden="true"><path d="M5 5l7 7m8 8 7 7M27 5l-7 7m-8 8-7 7"/></svg>
            MW2 hit marker
        </button>
        <button type="button" class="reaction-button" disabled={!connected || !enabled} on:click={() => onReact('metalpipe')}
                title="Drop a pipe · loud clang on impact">
            <span class="metal-pipe-icon" aria-hidden="true"><span class="metal-pipe-body"></span></span>Metal pipe
        </button>
        <button type="button" class="reaction-button" disabled={!connected || !enabled} on:click={() => onReact('flashbang')}
                title="Throw a CS:GO flashbang · bounces, rings, and fades from white">
            <span class="flashbang-icon" aria-hidden="true"><FlashbangGrenade/></span>Flashbang
        </button>
        <button type="button" class="reaction-button" disabled={!connected || !enabled} on:click={() => onReact('biden')}
                title="Joe Biden wanders around the bottom · parody with soundbites">
            <img class="biden-icon" src="/images/joe-biden-walking.png" alt=""/>Joe wander
        </button>
        <button type="button" class="reaction-button" disabled={!connected || !enabled} on:click={() => onReact('heart')}><span aria-hidden="true">❤️</span>Love</button>
        <button type="button" class="reaction-button" disabled={!connected || !enabled} on:click={() => onReact('laugh')}><span aria-hidden="true">😂</span>Laugh</button>
        <button type="button" class="reaction-button" disabled={!connected || !enabled} on:click={() => onReact('clap')}><span aria-hidden="true">👏</span>Applause</button>
    </div>
    <p class="reaction-help" role="status">{!enabled ? 'Reactions are off on this device.' : !connected ? 'Reconnect to send reactions.' : armed
        ? 'Click anywhere on the picture to place a hit marker. Escape cancels.'
        : beachBall ? 'Move your cursor into the ball to bump it. Everyone can play.'
        : 'React to the moment, or bring out a ball for the room.'}</p>
</section>

<style>
    .flashbang-icon { display: inline-flex; width: 14px; height: 26px; transform: rotate(25deg); }
    .biden-icon { width: 17px; height: 27px; object-fit: contain; }
</style>
