<script>
    import Icon from './Icon.svelte';
    import {api} from '../lib/api.js';

    export let onLogin;
    export let sessionMessage = '';
    let username = '';
    let password = '';
    let busy = false;
    let error = '';

    async function login() {
        if (busy) return;
        busy = true;
        error = '';
        try {
            const result = await api('/api/login', {method: 'POST', body: {username: username.trim(), password}});
            password = '';
            onLogin(result);
        } catch (cause) {
            error = cause.message;
        } finally {
            busy = false;
        }
    }
</script>

<main class="login-page">
    <section class="login-story" aria-label="Welcome to Helltube">
        <a class="brand" href="/" aria-label="Helltube home"><span class="brand-mark"><Icon name="flame"
                                                                                            size={26}/></span>helltube<span
                class="brand-period">.</span></a>
        <div class="login-art" aria-hidden="true">
            <div class="orbit orbit-one"></div>
            <div class="orbit orbit-two"></div>
            <div class="orbit orbit-three"></div>
            <div class="ticket"><span class="ticket-top">GOOD COMPANY. GREAT WATCHES.</span><span class="ticket-symbol"><Icon
                    name="play" size={58} stroke={1}/></span><span
                    class="ticket-bottom">ADMIT EVERYONE <span>↗</span></span></div>
            <span class="art-caption">NOT ANOTHER NIGHT OF “3, 2, 1, PLAY.”</span>
        </div>
        <div class="login-editorial"><p class="eyebrow">THE INTERNET’S COZIEST SCREENING ROOM</p>
            <h1>Different places.<br/>Same <em>playhead.</em></h1>
            <p>Pull up a chair. Share your next rabbit hole.<br/>Watch YouTube, Twitch VODs, and your own media, together.</p></div>
        <footer class="login-footer"><span><i class="status-dot"></i> Built for watching together</span><span>NO COUNTDOWNS REQUIRED</span>
        </footer>
    </section>
    <section class="login-form-panel">
        <div class="login-form-wrap">
            <span class="small-mark"><Icon name="film" size={24}/></span>
            <p class="eyebrow">YOUR SEAT IS WAITING</p>
            <h2>Come on in.</h2>
            <p class="muted login-intro">Sign in to find your people and press play.</p>
            {#if sessionMessage}
                <p class="notice-box" role="status">
                    <Icon name="info" size={18}/>{sessionMessage}</p>
            {/if}
            <form on:submit|preventDefault={login} class="stack-form">
                <label for="login-username">Username</label>
                <input id="login-username" name="username" autocomplete="username" placeholder="Your username"
                       bind:value={username} required minlength="3" maxlength="32" spellcheck="false"
                       autocapitalize="none"/>
                <label for="login-password">Password</label>
                <input id="login-password" name="password" type="password" autocomplete="current-password"
                       placeholder="Your password" bind:value={password} required maxlength="128"/>
                {#if error}
                    <p class="form-error" role="alert">
                        <Icon name="warning" size={17}/>{error}</p>
                {/if}
                <button class="button primary login-submit" type="submit" disabled={busy}>
                    {#if busy}<span class="spinner"></span>Signing in…
                    {:else}Enter Helltube
                        <Icon name="chevron" size={18}/>
                    {/if}
                </button>
            </form>
            <div class="invite-note">
                <Icon name="users" size={19}/>
                <p>A little more private. A lot more together.<br/><span>Need an account? Ask your Helltube administrator.</span>
                </p></div>
            <div class="login-features"><span><Icon name="wifi" size={15}/>In sync</span><span><Icon name="list"
                                                                                                     size={15}/>Shared queue</span><span><Icon
                    name="upload" size={15}/>Your files, too</span></div>
        </div>
        <p class="login-fineprint">ONE ROOM. ONE MOMENT. EVERYONE’S INVITED.</p>
    </section>
</main>
