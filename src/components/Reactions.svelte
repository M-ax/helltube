<script>
    export let connected = false;
    export let beachBall = false;
    export let armed = false;
    export let soundMuted = false;
    export let onReact;
    export let onSoundToggle;
</script>

<section class="reactions-panel" aria-label="Reactions">
    <div class="reactions-heading">
        <h3>Reactions</h3>
        <span>Shared with everyone here</span>
        <button class="reaction-sound" type="button" aria-pressed={soundMuted}
                aria-label="Mute reaction sounds" on:click={onSoundToggle}>
            {soundMuted ? 'Sound off' : 'Sound on'}
        </button>
    </div>
    <div class="reaction-buttons">
        <button type="button" class="reaction-button" disabled={!connected} aria-pressed={beachBall}
                on:click={() => onReact('beachball')}><span class="beach-ball-icon" aria-hidden="true"></span>Beach ball</button>
        <button type="button" class="reaction-button" disabled={!connected} aria-pressed={armed}
                on:click={() => onReact('hitmarker')}>
            <svg class="hitmarker-icon" viewBox="0 0 32 32" aria-hidden="true"><path d="M5 5l7 7m8 8 7 7M27 5l-7 7m-8 8-7 7"/></svg>
            MW2 hit marker
        </button>
        <button type="button" class="reaction-button" disabled={!connected} on:click={() => onReact('metalpipe')}
                title="Drop a pipe · loud clang on impact">
            <span class="metal-pipe-icon" aria-hidden="true"><span class="metal-pipe-body"></span></span>Metal pipe
        </button>
        <button type="button" class="reaction-button" disabled={!connected} on:click={() => onReact('heart')}><span aria-hidden="true">❤️</span>Love</button>
        <button type="button" class="reaction-button" disabled={!connected} on:click={() => onReact('laugh')}><span aria-hidden="true">😂</span>Laugh</button>
        <button type="button" class="reaction-button" disabled={!connected} on:click={() => onReact('clap')}><span aria-hidden="true">👏</span>Applause</button>
    </div>
    <p class="reaction-help" role="status">{!connected ? 'Reconnect to send reactions.' : armed
        ? 'Click anywhere on the picture to place a hit marker. Escape cancels.'
        : beachBall ? 'Move your cursor into the ball to bump it. Everyone can play.'
        : 'React to the moment, or bring out a ball for the room.'}</p>
</section>
