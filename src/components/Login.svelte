<script>
    import {onMount} from 'svelte';
    import Icon from './Icon.svelte';
    import {api} from '../lib/api.js';

    export let onLogin;
    export let sessionMessage = '';
    let username = '';
    let password = '';
    let displayName = '';
    let mode = 'login';
    let request = null;
    let restoring = true;
    let reconnecting = false;
    let events;
    let retry;
    let disposed = false;
    let busy = false;
    let error = '';

    function stopWatching() {
        events?.close();
        events = null;
        clearTimeout(retry);
        reconnecting = false;
    }

    function showLogin() {
        stopWatching();
        mode = 'login';
        password = '';
        error = '';
    }

    async function signInApproved() {
        if (busy || disposed || mode !== 'request') return;
        stopWatching();
        busy = true;
        error = '';
        try {
            const result = await api('/api/account-requests/claim', {method: 'POST'});
            if (!disposed) onLogin(result);
        } catch (cause) {
            if (disposed) return;
            // Another waiting tab may already have exchanged the shared receipt.
            const session = await api('/api/me').catch(() => null);
            if (disposed) return;
            if (session) onLogin(session);
            else {
                error = cause.message;
                if (!cause.status || cause.status >= 500 || cause.status === 429) {
                    retry = setTimeout(signInApproved, cause.status === 429 ? 60000 : 3000);
                }
            }
        } finally {
            busy = false;
        }
    }

    function watchRequest() {
        stopWatching();
        mode = 'request';
        if (request?.status === 'approved') { void signInApproved(); return; }
        if (request?.status !== 'pending') return;
        events = new EventSource('/api/account-requests/current/events');
        events.onopen = () => { reconnecting = false; };
        events.onerror = () => { reconnecting = true; };
        events.addEventListener('account-requests', event => {
            if (disposed || mode !== 'request') return;
            const data = JSON.parse(event.data);
            if (!data) {
                stopWatching();
                error = 'This request has expired or was completed in another tab. Please sign in or request an account again.';
                request = null;
                return;
            }
            request = data.request;
            if (request.status === 'approved') void signInApproved();
            else if (request.status === 'denied') stopWatching();
        });
    }

    onMount(() => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        api('/api/account-requests/current', {signal: controller.signal}).then(result => {
            if (disposed || !result.request) return;
            request = result.request;
            if (busy || username || password) return;
            username = request.username;
            displayName = request.displayName;
            watchRequest();
        }).catch(cause => {
            if (!disposed) error = `Could not check an existing account request. ${cause.message}`;
        }).finally(() => { clearTimeout(timeout); restoring = false; });
        return () => { disposed = true; clearTimeout(timeout); controller.abort(); stopWatching(); };
    });

    async function submitRequest() {
        if (busy || restoring) return;
        busy = true;
        error = '';
        try {
            const result = await api('/api/account-requests', {method: 'POST',
                body: {username: username.trim(), displayName: displayName.trim(), password}});
            password = '';
            if (disposed) return;
            request = result.request;
            watchRequest();
        } catch (cause) {
            if (!disposed) error = cause.message;
        } finally {
            busy = false;
        }
    }

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
            <h2>{mode === 'login' ? 'Come on in.' : request ? 'Your seat is on its way.' : 'Ask for a seat.'}</h2>
            <p class="muted login-intro">{mode === 'login' ? 'Sign in to find your people and press play.' :
                'Choose your details. An administrator will review your account request.'}</p>
            {#if sessionMessage}
                <p class="notice-box" role="status">
                    <Icon name="info" size={18}/>{sessionMessage}</p>
            {/if}
            {#if mode === 'request' && request}
                <div class="request-status" role="status" aria-live="polite">
                    <strong>@{request.username}</strong>
                    {#if request.status === 'pending'}
                        <h3>Waiting for approval</h3>
                        <p>Keep this page open. You’ll be signed in automatically as soon as an administrator approves your request.</p>
                        <p class="field-help">You can also come back and sign in with your chosen password after approval. Requests expire after seven days.</p>
                        {#if reconnecting}<p class="field-help">Reconnecting to check your request…</p>{/if}
                    {:else if request.status === 'approved'}
                        <h3>Request approved</h3>
                        <p>{busy ? 'Signing you in…' : 'Your account is ready. You can sign in now.'}</p>
                    {:else}
                        <h3>Request denied</h3>
                        <p>An administrator declined this request. Contact your Helltube administrator for more information.</p>
                    {/if}
                </div>
                {#if error}<p class="form-error" role="alert">{error}</p>{/if}
                {#if request.status === 'approved' && !busy}
                    <button class="button primary" on:click={signInApproved}>Sign in now</button>
                {:else if request.status === 'denied'}
                    <button class="button secondary" on:click={() => { request = null; error = ''; }}>Make another request</button>
                {/if}
                <button class="button secondary request-back" disabled={busy} on:click={showLogin}>Back to sign in</button>
            {:else}
            <form on:submit|preventDefault={mode === 'login' ? login : submitRequest} class="stack-form">
                <label for="login-username">Username</label>
                <input id="login-username" name="username" autocomplete="username" placeholder="Your username"
                       bind:value={username} required minlength="3" maxlength="32" spellcheck="false"
                       pattern={mode === 'request' ? '[A-Za-z0-9_\\-]{3,32}' : undefined}
                       autocapitalize="none"/>
                {#if mode === 'request'}
                    <p class="field-help">3–32 letters, numbers, underscores or hyphens.</p>
                    <label for="request-display-name">Display name</label>
                    <input id="request-display-name" name="displayName" autocomplete="nickname" bind:value={displayName}
                           placeholder="What should we call you?" required maxlength="80"/>
                {/if}
                <label for="login-password">Password</label>
                <input id="login-password" name="password" type="password" autocomplete={mode === 'login' ? 'current-password' : 'new-password'}
                       placeholder="Your password" bind:value={password} required minlength={mode === 'request' ? 10 : undefined} maxlength="128"/>
                {#if mode === 'request'}<p class="field-help">10–128 characters. Administrators won’t see your password.</p>{/if}
                {#if error}
                    <p class="form-error" role="alert">
                        <Icon name="warning" size={17}/>{error}</p>
                {/if}
                <button class="button primary login-submit" type="submit" disabled={busy || (restoring && mode === 'request')}>
                    {#if busy}<span class="spinner"></span>{mode === 'login' ? 'Signing in…' : 'Sending request…'}
                    {:else}{mode === 'login' ? 'Enter Helltube' : 'Send account request'}
                        <Icon name="chevron" size={18}/>
                    {/if}
                </button>
            </form>
            {/if}
            <div class="invite-note">
                <Icon name="users" size={19}/>
                <p>A little more private. A lot more together.<br/>
                    {#if mode === 'login'}
                        <button class="request-link" disabled={busy || restoring} on:click={() => { error = ''; password = ''; watchRequest(); }}>
                            {request ? 'View account request' : 'Request an account'}
                        </button>
                    {:else if !request}
                        <button class="request-link" disabled={busy} on:click={showLogin}>Already have an account? Sign in</button>
                    {/if}
                </p></div>
            <div class="login-features"><span><Icon name="wifi" size={15}/>In sync</span><span><Icon name="list"
                                                                                                     size={15}/>Shared queue</span><span><Icon
                    name="upload" size={15}/>Your files, too</span></div>
        </div>
        <p class="login-fineprint">ONE ROOM. ONE MOMENT. EVERYONE’S INVITED.</p>
    </section>
</main>

<style>
    .request-link { background: none; border: none; padding: 0; color: var(--accent, #eeaa91); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; font: inherit; }
    .request-link:disabled { opacity: 0.5; cursor: wait; }
    .request-status { padding: 20px; margin-bottom: 20px; border: 1px solid #5b413d; border-radius: 8px; background: #282029; overflow-wrap: anywhere; }
    .request-status h3 { margin: 12px 0; }
    .request-status p { line-height: 1.7; font-size: 13px; }
    .request-back { margin-top: 12px; }
</style>
