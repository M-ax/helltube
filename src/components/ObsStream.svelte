<script>
    import {api} from '../lib/api.js';

    export let room;
    export let connected;
    let credentials = null;
    let busy = false;
    let error = '';
    let notice = '';
    let showToken = false;

    async function generate() {
        busy = true;
        error = notice = '';
        try {
            const result = await api(`/api/rooms/${encodeURIComponent(room.id)}/obs-token`, {method: 'POST'});
            credentials = {...result, url: new URL(result.path, location.origin).href};
            showToken = false;
        } catch (cause) { error = cause.message; }
        finally { busy = false; }
    }

    async function revoke() {
        busy = true;
        error = notice = '';
        try {
            await api(`/api/rooms/${encodeURIComponent(room.id)}/obs-token`, {method: 'DELETE'});
            credentials = null;
            notice = 'OBS token revoked. Any stream using it has stopped.';
        } catch (cause) { error = cause.message; }
        finally { busy = false; }
    }

    async function copy(value) {
        try { await navigator.clipboard.writeText(value); notice = 'Copied.'; }
        catch { error = 'Select the field and copy it manually.'; }
    }
</script>

<details class="obs-stream">
    <summary>Stream with OBS Studio</summary>
    <p>In OBS, open Settings → Stream and choose <strong>Helltube</strong>. Create a token here, then paste the server URL and bearer token into OBS and start streaming.</p>
    <p>Use H.264 Baseline video, Opus audio, and one video layer. Recommended limits: 1080p, 60 fps, 6,000 Kbps video and 128 Kbps audio. Standard OBS also works with its WHIP service.</p>
    <div class="actions">
        <button class="button secondary" disabled={!connected || busy} on:click={generate}>
            {credentials ? 'Replace OBS token' : 'Create OBS token'}
        </button>
        <button class="button secondary" disabled={!connected || busy} on:click={revoke}>Revoke OBS token</button>
    </div>
    <p class="field-help">Tokens are private and allow streaming only to this room. Replacing or revoking a token stops its stream. Tokens expire with your sign-in session; signing out revokes them. You can close this page while streaming.</p>
    {#if credentials}
        <label for="obs-server">Server URL</label>
        <div class="field"><input id="obs-server" readonly value={credentials.url} on:focus={event => event.currentTarget.select()}/>
            <button class="button secondary" on:click={() => copy(credentials.url)}>Copy URL</button></div>
        <label for="obs-token">Bearer token</label>
        <div class="field"><input id="obs-token" type={showToken ? 'text' : 'password'} readonly value={credentials.token}
                                  autocomplete="off" on:focus={event => event.currentTarget.select()}/>
            <button class="button secondary" aria-pressed={showToken} on:click={() => showToken = !showToken}>{showToken ? 'Hide' : 'Show'} token</button>
            <button class="button secondary" on:click={() => copy(credentials.token)}>Copy token</button></div>
        <p class="field-help">Expires {new Date(credentials.expires).toLocaleString()}. Copy the token now; it is only shown here after creation.</p>
    {/if}
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
</details>

<style>
    .obs-stream {margin-top: 1rem; padding: 1rem; border: 1px solid var(--border, #454047); border-radius: 12px;}
    summary {cursor: pointer; font-weight: 700;}
    p {margin: .75rem 0;}
    label {display: block; margin-top: .75rem;}
    .actions, .field {display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .5rem;}
    input {flex: 1 1 220px; min-width: 0;}
</style>
