<script>
    import {onMount, onDestroy} from 'svelte';
    import Icon from './components/Icon.svelte';
    import Login from './components/Login.svelte';
    import Modal from './components/Modal.svelte';
    import Account from './components/Account.svelte';
    import Admin from './components/Admin.svelte';
    import Player from './components/Player.svelte';
    import Queue from './components/Queue.svelte';
    import Composer from './components/Composer.svelte';
    import Uploads from './components/Uploads.svelte';
    import {api} from './lib/api.js';
    import {initials} from './lib/format.js';
    import {createRealtime} from './lib/realtime.js';
    import {createUploadManager} from './lib/uploads.js';
    import {watchDeployment} from './lib/deployment-updates.js';

    const deployedCommit = __DEPLOYED_COMMIT__;

    let user = null;
    let capabilities = {};
    let checking = true;
    let startupError = '';
    let sessionMessage = '';
    let modal = null;
    let manager;
    let composer;
    let roomName = '';
    let editingRoom = null;
    let confirmRoomDelete = false;
    let roomBusy = false;
    let roomError = '';
    let roomsLoading = false;
    let signingOut = false;
    let sidebarOpen = false;
    let browserOnline = navigator.onLine;
    let toasts = [];
    let nextToastId = 0;
    let playerPreferences = {volume: 0.8, muted: false};
    let preferenceKey = 0;
    let preferenceQueue = null;
    const PREFERENCE_SAVE_DELAY = 400;
    const toastTimers = new Map();
    const client = createRealtime({onMessage: notify, onSessionEnded: sessionEnded});
    const realtimeState = client.state;
    $: room = $realtimeState.room;
    $: connected = $realtimeState.status === 'connected' && $realtimeState.joined && browserOnline;
    $: if (user && user.role !== 'admin' && modal === 'admin') modal = null;

    function notify(message, type = 'notice') {
        const id = ++nextToastId;
        toasts = [...toasts.slice(-3), {id, message, type}];
        toastTimers.set(id, setTimeout(() => dismissToast(id), type === 'error' ? 14000 : 8000));
    }

    function dismissToast(id) {
        toasts = toasts.filter((toast) => toast.id !== id);
        clearTimeout(toastTimers.get(id));
        toastTimers.delete(id);
    }

    function resetPreferences(account = null) {
        if (preferenceQueue) {
            clearTimeout(preferenceQueue.timer);
            preferenceQueue.controller?.abort();
        }
        preferenceKey++;
        const saved = account?.preferences;
        playerPreferences = {
            volume: typeof saved?.volume === 'number' && Number.isFinite(saved.volume)
                ? Math.max(0, Math.min(1, saved.volume)) : 0.8,
            muted: typeof saved?.muted === 'boolean' ? saved.muted : false,
        };
        preferenceQueue = account ? {
            key: preferenceKey, userId: account.id, saved: {...playerPreferences},
            timer: null, request: null, controller: null, ready: false,
        } : null;
    }

    function changePreferences(changes, {key, commit = false} = {}) {
        const state = preferenceQueue;
        if (!user || signingOut || !state || key !== state.key) return;
        const next = {...playerPreferences};
        if (typeof changes.volume === 'number' && Number.isFinite(changes.volume)) {
            next.volume = Math.max(0, Math.min(1, changes.volume));
        }
        if (typeof changes.muted === 'boolean') next.muted = changes.muted;
        if (next.volume !== playerPreferences.volume || next.muted !== playerPreferences.muted) {
            playerPreferences = next;
            user = {...user, preferences: playerPreferences};
            clearTimeout(state.timer);
            state.timer = setTimeout(() => void savePreferences(state), PREFERENCE_SAVE_DELAY);
        }
        if (commit) void savePreferences(state);
    }

    async function savePreferences(state = preferenceQueue) {
        if (!state || state !== preferenceQueue || user?.id !== state.userId) return;
        clearTimeout(state.timer);
        state.timer = null;
        state.ready = true;
        if (state.request) return state.request;
        state.request = (async () => {
            while (state === preferenceQueue && state.ready) {
                state.ready = false;
                const changes = {};
                for (const field of ['volume', 'muted']) {
                    if (playerPreferences[field] !== state.saved[field]) changes[field] = playerPreferences[field];
                }
                if (!Object.keys(changes).length) break;
                state.controller = new AbortController();
                try {
                    // Scope even authentication errors to this login before handling the response.
                    const response = await fetch('/api/me/preferences', {
                        method: 'PATCH', credentials: 'same-origin', keepalive: true,
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(changes), signal: state.controller.signal,
                    });
                    const result = await response.json().catch(() => ({}));
                    if (state !== preferenceQueue || user?.id !== state.userId) return;
                    if (!response.ok) {
                        if (response.status === 401) {
                            sessionEnded();
                            notify('Could not save your volume settings because your session ended.', 'error');
                            return;
                        }
                        throw new Error(result.error || `Request failed (${response.status}). Please try again.`);
                    }
                    if (result.user?.id !== state.userId) throw new Error('The server returned a different account.');
                    state.saved = {...state.saved, ...changes};
                } catch (cause) {
                    if (state === preferenceQueue && cause.name !== 'AbortError') {
                        notify(`Could not save your volume settings. ${cause.message}`, 'error');
                    }
                } finally {
                    state.controller = null;
                }
            }
        })();
        try {
            await state.request;
        } finally {
            state.request = null;
        }
    }

    function authenticated(result) {
        resetPreferences(result.user);
        user = {...result.user, preferences: playerPreferences};
        capabilities = result.capabilities || {};
        sessionMessage = '';
        checking = false;
        manager?.dispose();
        manager = createUploadManager(user.id, {onError: message => notify(message, 'error')});
        client.connect(user.id);
        void refreshRooms();
    }

    async function checkSession() {
        checking = true;
        startupError = '';
        try {
            authenticated(await api('/api/me'));
        } catch (cause) {
            if (cause.status !== 401) startupError = cause.message;
        } finally {
            checking = false;
        }
    }

    function sessionEnded() {
        resetPreferences();
        client.disconnect();
        manager?.dispose();
        manager = null;
        user = null;
        modal = null;
        toasts = [];
        sidebarOpen = false;
        sessionMessage = 'Your session has ended. Sign in again to rejoin your room.';
    }

    async function signOut() {
        signingOut = true;
        const key = preferenceKey;
        try {
            await savePreferences();
            if (key !== preferenceKey) return;
            await api('/api/logout', {method: 'POST'});
            if (key !== preferenceKey) return;
            sessionEnded();
            sessionMessage = 'You’re signed out. Your seat will be here when you get back.';
        } catch (cause) {
            if (key === preferenceKey) notify(cause.message, 'error');
        } finally {
            signingOut = false;
        }
    }

    async function refreshRooms() {
        roomsLoading = true;
        const userId = user?.id;
        try {
            const result = await api('/api/rooms');
            if (user?.id === userId) realtimeState.update((current) => ({...current, rooms: result.rooms}));
        } catch (cause) {
            if (user) notify(cause.message, 'error');
        } finally {
            roomsLoading = false;
        }
    }

    function joinRoom(id) {
        if ($realtimeState.selectedRoomId !== id || !$realtimeState.joined) client.join(id);
        sidebarOpen = false;
    }

    function openRoomForm(entry = null) {
        editingRoom = entry?.id ? entry : null;
        confirmRoomDelete = false;
        roomName = editingRoom?.name || '';
        roomError = '';
        modal = 'room';
    }

    async function createRoom() {
        if (roomBusy || !roomName.trim()) return;
        roomBusy = true;
        roomError = '';
        try {
            const result = await api(editingRoom ? `/api/rooms/${encodeURIComponent(editingRoom.id)}` : '/api/rooms', {
                method: editingRoom ? 'PATCH' : 'POST', body: {name: roomName.trim()}
            });
            if (!editingRoom) joinRoom(result.room.id);
            modal = null;
            void refreshRooms();
        } catch (cause) {
            roomError = cause.message;
        } finally {
            roomBusy = false;
        }
    }

    async function deleteRoom() {
        if (roomBusy || !editingRoom) return;
        roomBusy = true;
        roomError = '';
        try {
            await api(`/api/rooms/${encodeURIComponent(editingRoom.id)}`, {method: 'DELETE'});
            modal = null;
            void refreshRooms();
        } catch (cause) {
            roomError = cause.message;
        } finally {
            roomBusy = false;
        }
    }

    function updateUser(updated) {
        if (user?.id !== updated.id) return;
        user = {...updated, preferences: playerPreferences};
    }

    function focusComposer() {
        void composer?.focus();
    }

    onMount(() => {
        const stopWatching = import.meta.env.PROD ? watchDeployment({buildId: __BUILD_ID__}) : () => {};
        void checkSession();
        window.addEventListener('helltube:session-ended', sessionEnded);
        return () => {
            stopWatching();
            window.removeEventListener('helltube:session-ended', sessionEnded);
        };
    });
    onDestroy(() => {
        resetPreferences();
        client.disconnect();
        manager?.dispose();
        for (const timer of toastTimers.values()) clearTimeout(timer);
    });
</script>

<svelte:head><title>{user && room ? `${room.name} · Helltube` : 'Helltube · Watch together'}</title>
    <meta name="description"
          content="Your own corner of the internet. Watch videos together in perfectly good company."/>
</svelte:head>
<svelte:window on:online={() => { browserOnline = true; if (user) client.retry(); }}
               on:offline={() => browserOnline = false}/>

{#if checking}
    <main class="boot-screen"><span class="brand-mark"><Icon name="flame" size={28}/></span>
        <h1>helltube<span class="accent">.</span></h1>
        <p><span class="spinner"></span>Warming up the projector…</p></main>
{:else if startupError}
    <main class="boot-screen"><span class="brand-mark"><Icon name="offline" size={26}/></span>
        <h1>Can’t reach the room.</h1>
        <p class="form-error" role="alert">{startupError}</p>
        <button class="button primary" on:click={checkSession}>
            <Icon name="refresh" size={18}/>
            Try again
        </button>
    </main>
{:else if !user}
    <Login onLogin={authenticated} {sessionMessage}/>
{:else}
    <a href="#main-content" class="skip-link">Skip to the screening room</a>
    <div class="app-shell">
        {#if sidebarOpen}
            <button class="sidebar-scrim" aria-label="Close room navigation"
                    on:click={() => sidebarOpen = false}></button>
        {/if}
        <aside class="sidebar" class:open={sidebarOpen} aria-label="Room navigation">
            <div class="sidebar-brand"><a class="brand" href="/" aria-label="Helltube home"><span class="brand-mark"><Icon
                    name="flame" size={23}/></span>helltube<span class="brand-period">.</span></a>
                <button class="icon-button sidebar-close" aria-label="Close room navigation"
                        on:click={() => sidebarOpen = false}>
                    <Icon name="close"/>
                </button>
            </div>
            <div class="sidebar-intro"><span class="status-dot"></span>Your corner of the internet.</div>
            <div class="rooms-label"><h2 class="eyebrow">SCREENING ROOMS</h2>
                <button class="icon-button" title="Create a room" aria-label="Create a room" on:click={openRoomForm}>
                    <Icon name="plus" size={17}/>
                </button>
            </div>
            <nav class="room-list" aria-label="Screening rooms">
                {#each $realtimeState.rooms as entry (entry.id)}
                    <div class="room-navigation-row">
                    <button class="room-button" class:active={$realtimeState.selectedRoomId === entry.id}
                            aria-current={$realtimeState.selectedRoomId === entry.id ? 'page' : undefined}
                            on:click={() => joinRoom(entry.id)}><span class="room-hash"><Icon name="room"
                                                                                              size={20}/></span><span
                            class="room-button-copy"><strong>{entry.name}</strong><span>{entry.currentTitle || 'Ready for a good watch'}</span></span><span
                            class="member-count" title={`${entry.memberCount} in room`}><Icon name="users"
                                                                                              size={11}/>{entry.memberCount}</span>
                    </button>
                    {#if user.role === 'admin' || entry.ownerId === user.id}
                        <button class="icon-button room-edit" title={`Manage ${entry.name}`} aria-label={`Manage ${entry.name}`}
                                on:click={() => openRoomForm(entry)}><Icon name="edit" size={15}/></button>
                    {/if}
                    </div>
                {/each}
                {#if !$realtimeState.rooms.length}<p
                        class="sidebar-empty">{roomsLoading ? 'Finding your rooms…' : 'No rooms yet. Start one and make it yours.'}</p>{/if}
            </nav>
            <button class="create-room-button" on:click={openRoomForm}>
                <Icon name="plus" size={17}/>
                Create a room
            </button>
            <div class="sidebar-bottom">
                <div class="sidebar-note">
                    <Icon name="film" size={25} stroke={1.2}/>
                    <p>One screen.<br/><em>Better company.</em></p><span>MAKE A NIGHT OF IT.</span></div>
                {#if user.role === 'admin'}
                    <button class="sidebar-action" on:click={() => { modal = 'admin'; sidebarOpen = false; }}>
                        <Icon name="shield" size={18}/>
                        Manage users
                        <Icon name="chevron" size={14}/>
                    </button>
                {/if}
                <button class="sidebar-action" on:click={() => { modal = 'account'; sidebarOpen = false; }}>
                    <Icon name="settings" size={18}/>
                    Account settings
                    <Icon name="chevron" size={14}/>
                </button>
                <div class="profile-card">
                    <button class="profile-button" on:click={() => modal = 'account'}
                            aria-label={`Account settings for ${user.displayName}`}><span
                            class="avatar">{initials(user.displayName)}
                        <i></i></span><span><strong>{user.displayName}</strong><span>@{user.username}</span></span>
                    </button>
                    <button class="icon-button" disabled={signingOut} aria-label="Sign out" title="Sign out"
                            on:click={signOut}>
                        <Icon name="logout" size={18}/>
                    </button>
                </div>
                <p class="deployment-label" title={deployedCommit ? `Deployed commit: ${deployedCommit}` : 'Commit unavailable for this build'}>
                    {deployedCommit ? `Commit ${deployedCommit.slice(0, 7)}` : 'Commit unavailable'}
                </p>
            </div>
        </aside>

        <main class="workspace" id="main-content" tabindex="-1">
            <header class="workspace-header">
                <div class="room-heading">
                    <button class="icon-button mobile-menu" aria-label="Open room navigation"
                            aria-expanded={sidebarOpen} on:click={() => sidebarOpen = !sidebarOpen}>
                        <Icon name="list" size={22}/>
                    </button>
                    <span class="header-room-icon"><Icon name={room ? 'room' : 'film'} size={24}/></span>
                    <div>
                        <p class="eyebrow">{room ? 'SETTLE IN. YOU’RE IN GOOD COMPANY.' : 'A SHARED SCREEN. A BETTER EVENING.'}</p>
                        <h1>{room?.name || ($realtimeState.selectedRoomId ? 'Joining your room…' : 'Welcome to the good part.')}</h1>
                    </div>
                </div>
                <div class="header-presence"><span class="connection-pill"
                                                   class:offline={$realtimeState.status !== 'connected' || !browserOnline}><i
                        class="status-dot"></i>{!browserOnline ? 'Offline' : $realtimeState.status === 'connected' ? 'Connected' : 'Reconnecting'}</span>
                    {#if room}<span class="room-member-total"><Icon name="users" size={17}/>{room.members.length}<span>in the room</span></span>{/if}
                </div>
            </header>

            {#if !browserOnline || $realtimeState.status === 'reconnecting' || $realtimeState.status === 'offline'}
                <div class="connection-banner" role="status">
                    <Icon name="offline" size={18}/>
                    <span>{!browserOnline ? 'You’re offline. Shared controls are paused until your connection returns.' : 'The room connection was interrupted. Rejoining automatically; old commands won’t be replayed.'}</span>
                    <button class="text-button" on:click={client.retry} disabled={!browserOnline}>Reconnect</button>
                </div>
            {/if}
            {#if capabilities.ffmpeg === false || capabilities.youtube === false}
                <div class="capability-banner" role="status">
                    <Icon name="warning" size={18}/>
                    <div><strong>Some features need a little
                        setup.</strong><span>{capabilities.ffmpeg === false ? 'FFmpeg is missing on the server, so video preparation is unavailable. ' : ''}{capabilities.youtube === false ? 'yt-dlp is missing, so YouTube submissions are unavailable. ' : ''}
                        Ask your administrator to install the missing binaries and restart the server.</span></div>
                </div>
            {/if}
            {#if user.defaultPassword && user.role === 'admin'}
                <div class="setup-banner">
                    <Icon name="shield" size={19}/>
                    <div><strong>Before the first watch, change the setup password.</strong><span>Default administrator credentials are still active: <code>admin / garbageTime_</code>. Keep your room yours.</span>
                    </div>
                    <button class="button secondary small" on:click={() => modal = 'account'}>Secure account
                        <Icon name="chevron" size={15}/>
                    </button>
                </div>
            {/if}

            {#if !$realtimeState.selectedRoomId}
                <section class="lobby">
                    <div class="lobby-welcome"><span class="eyebrow">COME FOR A VIDEO. STAY FOR THE COMPANY.</span>
                        <h2>Find your people.<br/>Pick your <em>room.</em></h2>
                        <p>The rabbit holes, the old favorites, the “you have to see this.”<br/>They all belong here.
                        </p>
                        <button class="button primary" on:click={openRoomForm}>
                            <Icon name="plus" size={18}/>
                            Start a screening room
                        </button>
                        <span class="lobby-decoration" aria-hidden="true"><Icon name="film" size={94}
                                                                                stroke={0.7}/></span></div>
                    <div class="section-heading"><h3>Open doors<span class="count">{$realtimeState.rooms.length}</span>
                    </h3>
                        <button class="text-button" disabled={roomsLoading} on:click={refreshRooms}>
                            <Icon name="refresh" size={15}/>
                            Refresh
                        </button>
                    </div>
                    <div class="room-cards">
                        {#each $realtimeState.rooms as entry (entry.id)}
                            <button class="room-card" on:click={() => joinRoom(entry.id)}><span class="room-card-icon"><Icon
                                    name="room" size={25}/></span><span
                                    class="room-card-info"><strong>{entry.name}</strong><span>{entry.currentTitle || 'Nothing on screen yet. Bring the first pick.'}</span></span><span
                                    class="room-card-footer"><span><Icon name="users"
                                                                         size={15}/>{entry.memberCount} {entry.memberCount === 1 ? 'person' : 'people'}</span><span>Join room<Icon
                                    name="chevron" size={16}/></span></span></button>
                        {/each}
                        {#if !$realtimeState.rooms.length}
                            <div class="lobby-empty">
                                <Icon name="film" size={27}/>
                                <h3>{roomsLoading ? 'Finding the open doors…' : 'The first room could be yours.'}</h3>
                                <p>{roomsLoading ? 'Connecting to your Helltube server.' : 'Create a room above, then invite your people to join.'}</p>
                            </div>
                        {/if}
                    </div>
                </section>
                <Uploads {manager}/>
            {:else}
                <div class="work-grid">
                    <section class="stage" aria-label="Watch together">
                        {#key preferenceKey}
                            <Player {room} {connected} clockOffset={$realtimeState.clockOffset} rtt={$realtimeState.rtt}
                                    overlay={$realtimeState.overlay} onCommand={client.command} onAdd={focusComposer}
                                    preferences={playerPreferences} {preferenceKey} onPreferencesChange={changePreferences}/>
                        {/key}
                        <Composer bind:this={composer} {room} {connected} {capabilities} {manager} {notify}/>
                        <Uploads {manager}/>
                        <section class="room-company" aria-label="People in this room">
                            <div class="section-heading">
                                <h3>
                                    <Icon name="users" size={17}/>
                                    Here with you<span class="count">{room?.members.length || 0}</span></h3>
                                <span class="field-help">SAME MOMENT. DIFFERENT SOFAS.</span></div>
                            <div class="member-list">
                                {#each room?.members || [] as member (member.id)}
                                    <div class="member-chip"><span
                                            class="avatar small">{initials(member.displayName)}</span><span>{member.displayName}</span>
                                        {#if member.id === user.id}<span class="you-label">you</span>{/if}
                                    </div>
                                {/each}
                                {#if !room}<p class="muted">Waiting for a fresh room state…</p>{/if}
                            </div>
                        </section>
                        <footer class="stage-footer"><span><Icon name="flame" size={15}/>HELLTUBE</span><span>A LITTLE LESS ALONE ON THE INTERNET.</span>
                        </footer>
                    </section>
                    <Queue {room} {connected} onCommand={client.command} onAdd={focusComposer}/>
                </div>
            {/if}
        </main>
    </div>

    {#if modal === 'account'}
        <Account {user} onClose={() => modal = null} onUpdate={updateUser}/>
    {:else if modal === 'admin' && user.role === 'admin'}
        <Admin {user} onClose={() => modal = null} onUpdate={updateUser}/>
    {:else if modal === 'room'}
        <Modal title={editingRoom ? `Manage ${editingRoom.name}` : 'Make room for a good night.'}
               subtitle="Give your gathering a name. Everyone with an account can join." onClose={() => { if (!roomBusy) modal = null; }}>
            <form class="stack-form" on:submit|preventDefault={createRoom}><label for="room-name">Room
                name</label><input id="room-name" data-initial-focus bind:value={roomName}
                                   placeholder="e.g. The late-night rabbit hole" required maxlength="50" disabled={roomBusy}
                                   autocomplete="off"/>
                <p class="field-help">A shared queue, a synchronized screen, and a place for your people.</p>
                {#if roomError}<p class="form-error" role="alert">{roomError}</p>{/if}
                <button class="button primary" type="submit" disabled={roomBusy || !roomName.trim()}>
                    {#if roomBusy}<span class="spinner"></span>Saving…
                    {:else}
                        <Icon name={editingRoom ? 'edit' : 'plus'} size={18}/>
                        {editingRoom ? 'Save room' : 'Create and join room'}
                    {/if}
                </button>
            </form>
            {#if editingRoom}
                <div class="stack-form room-delete">
                    {#if confirmRoomDelete}
                        <p>Delete “{editingRoom.name}” and its queue? Everyone in this room will return to the room list. This cannot be undone.</p>
                        <button class="button danger-button" disabled={roomBusy} on:click={deleteRoom}>Confirm delete room</button>
                        <button class="button secondary" disabled={roomBusy} on:click={() => confirmRoomDelete = false}>Cancel</button>
                    {:else}
                        <button class="button danger-button" disabled={roomBusy} on:click={() => confirmRoomDelete = true}><Icon name="trash" size={16}/>Delete room</button>
                    {/if}
                </div>
            {/if}
        </Modal>
    {/if}
{/if}

<div class="toast-region" aria-label="Notifications">
    {#each toasts as toast (toast.id)}
        <div class="toast" class:error={toast.type === 'error'} role={toast.type === 'error' ? 'alert' : 'status'}>
            <Icon name={toast.type === 'error' ? 'warning' : 'check'} size={19}/>
            <span>{toast.message}</span>
            <button class="icon-button" aria-label="Dismiss notification" on:click={() => dismissToast(toast.id)}>
                <Icon name="close" size={17}/>
            </button>
        </div>
    {/each}
</div>
