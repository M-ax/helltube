<script>
    import Modal from './Modal.svelte';
    import Icon from './Icon.svelte';
    import {api} from '../lib/api.js';
    import {initials} from '../lib/format.js';

    export let user;
    export let onClose;
    export let onUpdate;
    let displayName = user.displayName;
    let currentPassword = '';
    let password = '';
    let confirmPassword = '';
    let busy = '';
    let error = '';
    let success = '';

    async function save(kind) {
        if (busy) return;
        error = '';
        success = '';
        if (kind === 'password' && password !== confirmPassword) {
            error = 'The new passwords don’t match.';
            return;
        }
        busy = kind;
        try {
            const result = await api('/api/me', {
                method: 'PATCH',
                body: kind === 'profile' ? {displayName: displayName.trim()} : {currentPassword, password},
            });
            onUpdate(result.user);
            if (kind === 'password') {
                currentPassword = '';
                password = '';
                confirmPassword = '';
            }
            success = kind === 'profile' ? 'Display name updated. Looking good.' : 'Your password has been changed.';
        } catch (cause) {
            error = cause.message;
        } finally {
            busy = '';
        }
    }
</script>

<Modal title="Make yourself at home." subtitle="Your name in the room. Your account, kept safe." {onClose}>
    <div class="account-identity"><span class="avatar large">{initials(user.displayName)}</span>
        <div><strong>{user.displayName}</strong><span class="muted">@{user.username}</span></div>
        <span class="tag">{user.role}</span></div>
    {#if user.defaultPassword}
        <p class="notice-box warning">
            <Icon name="shield" size={18}/>
            Your account still uses the default setup password. Choose a new one below.
        </p>
    {/if}
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    {#if success}
        <p class="form-success" role="status">
            <Icon name="check" size={17}/>{success}</p>
    {/if}
    <form on:submit|preventDefault={() => save('profile')} class="stack-form account-section">
        <h3>In the room</h3>
        <label for="account-name">Display name</label>
        <input id="account-name" data-initial-focus bind:value={displayName} required maxlength="64"
               autocomplete="nickname"/>
        <p class="field-help">This is how other people see you. Your username stays the same.</p>
        <button class="button secondary" disabled={!!busy || !displayName.trim()}
                type="submit">{busy === 'profile' ? 'Saving…' : 'Save display name'}</button>
    </form>
    <form on:submit|preventDefault={() => save('password')} class="stack-form account-section">
        <h3>A little peace of mind</h3>
        <label for="account-current">Current password</label><input id="account-current" type="password"
                                                                    autocomplete="current-password"
                                                                    bind:value={currentPassword} required
                                                                    maxlength="128"/>
        <div class="form-columns">
            <div><label for="account-password">New password</label><input id="account-password" type="password"
                                                                          autocomplete="new-password"
                                                                          bind:value={password} required minlength="10"
                                                                          maxlength="128"/></div>
            <div><label for="account-confirm">Confirm new password</label><input id="account-confirm" type="password"
                                                                                 autocomplete="new-password"
                                                                                 bind:value={confirmPassword} required
                                                                                 minlength="10" maxlength="128"/></div>
        </div>
        <p class="field-help">Use 10–128 characters. Make it something only you know.</p>
        <button class="button primary" disabled={!!busy} type="submit">
            <Icon name="shield" size={17}/>{busy === 'password' ? 'Changing password…' : 'Change password'}</button>
    </form>
</Modal>