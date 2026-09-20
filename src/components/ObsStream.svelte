<script>
    import {api} from '../lib/api.js';
    import {desktopLimits} from '../../shared/desktop-quality.js';

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
    <p>In OBS, open <strong>Settings → Stream</strong> and select <strong>WHIP</strong> (also called <strong>WHIP Service</strong>) as the service.
        Create a token below, then paste the <strong>Server URL</strong> and <strong>Bearer token</strong> into the matching OBS fields.</p>
    <ul class="obs-settings">
        <li><strong>Stream:</strong> If Simulcast is shown, set <strong>Total Layers</strong> to <strong>1</strong>.</li>
        <li><strong>Output:</strong> Set Output Mode to <strong>Advanced</strong>. Under Streaming, select the <strong>x264</strong> video encoder (H.264),
            <strong>baseline</strong> profile, <strong>CBR</strong> rate control, up to <strong>{(desktopLimits.videoBitrate / 1000).toLocaleString()} Kbps</strong>,
            and a <strong>2-second</strong> keyframe interval. Baseline uses no B-frames.</li>
        <li><strong>Audio:</strong> Under Output → Streaming, select the <strong>Opus</strong> audio encoder.
            Under Output → Audio, set the streaming track to <strong>{desktopLimits.audioBitrate / 1000} Kbps</strong>.
            Under Settings → Audio, use <strong>48 kHz</strong> and <strong>Stereo</strong>.</li>
        <li><strong>Video:</strong> Set Output (Scaled) Resolution to at most <strong>{desktopLimits.width}×{desktopLimits.height}</strong>
            and FPS to at most <strong>{desktopLimits.frameRate}</strong>. Under Advanced → Video, use <strong>NV12</strong> and <strong>Rec. 709</strong> for SDR.</li>
    </ul>
    <p>Apply the settings, add your capture sources, and select <strong>Start Streaming</strong>. Lower the video bitrate, resolution, or FPS if your connection or computer cannot keep up.</p>
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
    .obs-settings {margin: .75rem 0; padding-left: 1.25rem;}
    .obs-settings li + li {margin-top: .5rem;}
    label {display: block; margin-top: .75rem;}
    .actions, .field {display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .5rem;}
    input {flex: 1 1 220px; min-width: 0;}
</style>
