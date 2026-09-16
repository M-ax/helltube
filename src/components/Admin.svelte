<script>
    import {onMount} from 'svelte';
    import Modal from './Modal.svelte';
    import Icon from './Icon.svelte';
    import {api} from '../lib/api.js';
    import {initials} from '../lib/format.js';

    export let user;
    export let onClose;
    export let onUpdate;
    let users = [];
    let loading = true;
    let busy = false;
    let error = '';
    let success = '';
    let editing = null;
    let formOpen = false;
    let username = '';
    let displayName = '';
    let password = '';
    let role = 'user';
    let deleting = null;

    async function load() {
        loading = true;
        error = '';
        try {
            users = (await api('/api/users')).users;
        } catch (cause) {
            error = cause.message;
        } finally {
            loading = false;
        }
    }

    onMount(load);

    function edit(member = null) {
        editing = member;
        formOpen = true;
        deleting = null;
        username = member?.username || '';
        displayName = member?.displayName || '';
        role = member?.role || 'user';
        password = '';
        error = '';
        success = '';
    }

    async function save() {
        if (busy) return;
        busy = true;
        error = '';
        success = '';
        try {
            const body = {displayName: displayName.trim(), role, ...(password ? {password} : {})};
            const result = await api(editing ? `/api/users/${encodeURIComponent(editing.id)}` : '/api/users', {
                method: editing ? 'PATCH' : 'POST', body: editing ? body : {...body, username: username.trim()},
            });
            const wasEditing = !!editing;
            formOpen = false;
            password = '';
            if (result.user.id === user.id) onUpdate(result.user);
            await load();
            success = wasEditing ? 'Account updated.' : 'Account created. Share the credentials privately with your guest.';
        } catch (cause) {
            error = cause.message;
        } finally {
            busy = false;
        }
    }

    async function remove(member) {
        if (busy) return;
        busy = true;
        error = '';
        try {
            await api(`/api/users/${encodeURIComponent(member.id)}`, {method: 'DELETE'});
            deleting = null;
            users = users.filter((entry) => entry.id !== member.id);
            success = 'Account deleted.';
        } catch (cause) {
            error = cause.message;
        } finally {
            busy = false;
        }
    }
</script>

<Modal title="Good company starts here." subtitle="Create accounts and manage who has a seat." {onClose} wide>
    <div class="section-heading">
        <h3>
            <Icon name="users" size={18}/>
            Accounts <span class="count">{users.length}</span></h3>
        <button class="button primary small" disabled={busy} on:click={() => edit()}>
            <Icon name="plus" size={16}/>
            Create user
        </button>
    </div>
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    {#if success}<p class="form-success" role="status">{success}</p>{/if}
    {#if formOpen}
        <form class="admin-form stack-form" on:submit|preventDefault={save}>
            <div class="section-heading"><h3>{editing ? `Edit @${editing.username}` : 'A new face in the room'}</h3>
                <button class="icon-button" type="button" aria-label="Close user form" disabled={busy}
                        on:click={() => { formOpen = false; password = ''; }}>
                    <Icon name="close" size={18}/>
                </button>
            </div>
            <div class="form-columns">
                <div><label for="admin-username">Username</label><input id="admin-username" bind:value={username}
                                                                        disabled={!!editing} required
                                                                        pattern={'[A-Za-z0-9_\\-]{3,32}'} minlength="3"
                                                                        maxlength="32" autocomplete="off"
                                                                        spellcheck="false"/>
                    <p class="field-help">3–32 letters, numbers, underscores or hyphens.</p></div>
                <div><label for="admin-display">Display name</label><input id="admin-display" bind:value={displayName}
                                                                           required maxlength="64" autocomplete="off"/>
                </div>
            </div>
            <div class="form-columns">
                <div><label for="admin-password">{editing ? 'New password (optional)' : 'Password'}</label><input
                        id="admin-password" type="password" bind:value={password} required={!editing} minlength="10"
                        maxlength="128" autocomplete="new-password"/>
                    <p class="field-help">10–128
                        characters.{editing ? ' Leave empty to keep the existing password.' : ''}</p></div>
                <div><label for="admin-role">Role</label><select id="admin-role" bind:value={role}>
                    <option value="user">User</option>
                    <option value="admin">Administrator</option>
                </select>
                    <p class="field-help">Administrators can manage all accounts.</p></div>
            </div>
            <button class="button primary" type="submit"
                    disabled={busy || !displayName.trim()}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create account'}</button>
        </form>
    {/if}
    {#if loading}
        <div class="loading-line"><span class="spinner"></span>Loading accounts…</div>
    {:else if !users.length}
        <div class="empty-small"><p>No accounts to display.</p>
            <button class="button secondary small" on:click={load}>Try again</button>
        </div>
    {:else}
        <ul class="admin-users">
            {#each users as member (member.id)}
                <li>
                    <div class="admin-user-row"><span class="avatar">{initials(member.displayName)}</span>
                        <div class="user-detail"><strong>{member.displayName}
                            {#if member.id === user.id}<span class="muted"> (you)</span>{/if}
                        </strong><span class="muted">@{member.username}</span></div>
                        <span class="tag">{member.role}</span>
                        <button class="icon-button" aria-label={`Edit ${member.username}`} disabled={busy}
                                on:click={() => edit(member)}>
                            <Icon name="edit" size={17}/>
                        </button>
                        <button class="icon-button danger" aria-label={`Delete ${member.username}`}
                                title={member.id === user.id ? 'You cannot delete your own account' : 'Delete account'}
                                disabled={busy || member.id === user.id || (member.role === 'admin' && users.filter((entry) => entry.role === 'admin').length === 1)}
                                on:click={() => { deleting = member.id; formOpen = false; }}>
                            <Icon name="trash" size={17}/>
                        </button>
                    </div>
                    {#if deleting === member.id}
                        <div class="delete-confirm"><p>Delete <strong>@{member.username}</strong>? Their access will end
                            immediately.</p>
                            <div class="button-row">
                                <button class="button danger-button small" disabled={busy}
                                        on:click={() => remove(member)}>{busy ? 'Deleting…' : 'Yes, delete account'}</button>
                                <button class="button secondary small" disabled={busy} on:click={() => deleting = null}>
                                    Keep account
                                </button>
                            </div>
                        </div>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
</Modal>