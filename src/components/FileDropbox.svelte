<script>
    import {onDestroy} from 'svelte';
    import Icon from './Icon.svelte';
    import {api} from '../lib/api.js';
    import {bytes} from '../lib/format.js';
    import {delivery, sharedFileUrl} from '../lib/delivery.js';
    import {transferRoomFile} from '../lib/room-files.js';

    export let room;
    export let user;
    export let connected;
    export let snapshot;
    export let busy = false;
    let input;
    let resumeInput;
    let resumeFile = null;
    let controller;
    let activeId = null;
    let progress = 0;
    let retrying = false;
    let error = '';
    let dragging = false;
    let confirmId = null;
    let deleting = null;
    let downloading = null;
    let alive = true;
    $: files = snapshot?.roomId === room.id ? snapshot.files : null;

    async function share(selected, resume = null) {
        if (!connected || busy || !selected.length) return;
        busy = true;
        error = '';
        controller = new AbortController();
        const {signal} = controller;
        try {
            for (const file of selected) {
                signal.throwIfAborted();
                const saved = resume || (await api(`/api/rooms/${encodeURIComponent(room.id)}/files`, {
                    method: 'POST', body: {name: file.name, size: file.size, lastModified: file.lastModified}, signal,
                })).file;
                signal.throwIfAborted();
                activeId = saved.id;
                progress = saved.received;
                await transferRoomFile(file, saved, {signal, onProgress: status => {
                    if (Number.isFinite(status.received)) progress = status.received;
                    retrying = status.retrying;
                }});
            }
        } catch (cause) {
            if (alive && !signal.aborted) error = cause.message;
        } finally {
            if (alive) { busy = false; activeId = null; retrying = false; }
        }
    }

    function selected(event) {
        const list = Array.from(event.currentTarget.files || []);
        event.currentTarget.value = '';
        void share(list);
    }

    function resumeSelected(event) {
        const list = Array.from(event.currentTarget.files || []);
        event.currentTarget.value = '';
        void share(list, resumeFile);
    }

    function dragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        dragging = connected && !busy;
        event.dataTransfer.dropEffect = dragging ? 'copy' : 'none';
    }

    function drop(event) {
        event.preventDefault();
        event.stopPropagation();
        dragging = false;
        void share(Array.from(event.dataTransfer.files || []));
    }

    async function download(file) {
        if (!connected || downloading) return;
        error = '';
        downloading = file.id;
        try {
            const [access, config] = await Promise.all([api(`/api/files/${file.id}/access`), delivery.getConfig()]);
            if (!alive) return;
            const link = document.createElement('a');
            link.href = sharedFileUrl(file.id, access.url, config, true);
            link.download = file.name;
            link.rel = 'noreferrer';
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (cause) { if (alive) error = cause.message; }
        finally { if (alive) downloading = null; }
    }

    async function remove(file) {
        if (!connected || deleting) return;
        error = '';
        deleting = file.id;
        try {
            await api(`/api/files/${file.id}`, {method: 'DELETE'});
            confirmId = null;
        } catch (cause) { if (alive) error = cause.message; }
        finally { if (alive) deleting = null; }
    }

    onDestroy(() => { alive = false; controller?.abort(); busy = false; });
</script>

<section class="file-dropbox" aria-label="Shared files">
    <div class="section-heading">
        <h3><Icon name="file" size={18}/>Shared files<span class="count">{files?.length || 0}</span></h3>
        <span class="field-help">FOR THIS ROOM</span>
    </div>
    <p class="description">Drop something off for everyone in {room.name}.</p>
    <input bind:this={input} type="file" multiple class="sr-only" tabindex="-1"
           aria-label="Choose shared files" disabled={!connected || busy} on:change={selected}/>
    <input bind:this={resumeInput} type="file" class="sr-only" tabindex="-1"
           aria-label="Reselect shared file" disabled={!connected || busy} on:change={resumeSelected}/>
    <button class="drop-target" class:dragging disabled={!connected || busy}
            on:click={() => input.click()} on:dragover={dragOver}
            on:dragleave={() => dragging = false} on:drop={drop}>
        <Icon name="upload" size={22}/>
        <span><strong>{busy ? 'Sharing files…' : 'Drop files here or choose files'}</strong>
        <small>Any file type · Available to everyone in this room</small></span>
    </button>
    {#if !connected}<p class="field-help" role="status">Reconnecting to the room…</p>{/if}
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    {#if files === null}
        <p class="empty" role="status">Loading shared files…</p>
    {:else if !files.length}
        <p class="empty">No shared files yet. Add the first one.</p>
    {:else}
        <ul class="file-list">
            {#each files as file (file.id)}
                <li>
                    <div class="file-row">
                        <Icon name="file" size={20}/>
                        <div class="file-info">
                            <strong title={file.name}>{file.name}</strong>
                            <span>{bytes(file.size)} · {file.addedBy}</span>
                            {#if !file.complete}
                                <small>{activeId === file.id ? (retrying ? 'Connection interrupted. Retrying…' : 'Uploading…') : 'Upload incomplete'}
                                    · {bytes(activeId === file.id ? progress : file.received)} / {bytes(file.size)}</small>
                            {/if}
                        </div>
                        <div class="file-actions">
                            {#if file.complete}
                                <button class="icon-button" aria-label={`Download ${file.name}`} title="Download"
                                        disabled={!connected || downloading === file.id} on:click={() => download(file)}>
                                    <Icon name="download" size={18}/>
                                </button>
                            {:else if activeId === file.id}
                                <button class="icon-button" aria-label={`Pause sharing ${file.name}`} title="Pause"
                                        on:click={() => controller?.abort()}><Icon name="pause" size={18}/></button>
                            {:else if file.userId === user.id}
                                <button class="text-button" disabled={!connected || busy} on:click={() => {
                                    resumeFile = file; resumeInput.click();
                                }} aria-label={`Resume sharing ${file.name}`}>Resume</button>
                            {/if}
                            {#if file.userId === user.id || user.role === 'admin' || room.ownerId === user.id}
                                <button class="icon-button danger" aria-label={`Remove shared file ${file.name}`} title="Remove file"
                                        disabled={!connected || activeId === file.id || deleting === file.id}
                                        on:click={() => confirmId = file.id}><Icon name="trash" size={17}/></button>
                            {/if}
                        </div>
                    </div>
                    {#if !file.complete}
                        <progress max={file.size || 1} value={activeId === file.id ? progress : file.received}
                                  aria-label={`Sharing progress for ${file.name}`}></progress>
                    {/if}
                    {#if confirmId === file.id}
                        <div class="remove-confirm" role="group" aria-label={`Confirm removal of ${file.name}`}>
                            <span>Remove this file for everyone?</span>
                            <button class="text-button" disabled={!connected || deleting === file.id} on:click={() => remove(file)}>Remove</button>
                            <button class="text-button" disabled={deleting === file.id} on:click={() => confirmId = null}>Keep</button>
                        </div>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
    <p class="field-help footnote">Files stay here until removed. To resume after leaving or reloading, reselect the original file. Incomplete uploads expire after inactivity.</p>
</section>

<style>
    .file-dropbox { padding: 22px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
    .description { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
    .drop-target { width: 100%; display: flex; align-items: center; justify-content: center; gap: 14px; padding: 20px 14px;
        border: 1px dashed var(--muted); border-radius: 10px; background: transparent; color: var(--accent); text-align: left; }
    .drop-target.dragging, .drop-target:hover:enabled { border-color: var(--accent); background: var(--accent-dim); }
    .drop-target span { display: grid; gap: 5px; }
    .drop-target strong { font-size: 13px; }
    .drop-target small, .file-info span, .file-info small { color: var(--muted); font-size: 12px; }
    .empty { color: var(--muted); text-align: center; padding: 18px 0 6px; font-size: 13px; }
    .file-list { list-style: none; margin: 16px 0 0; padding: 0; max-height: 360px; overflow: auto; }
    .file-list li { padding: 12px 0; border-bottom: 1px solid var(--line); }
    .file-row { display: flex; align-items: center; gap: 12px; }
    .file-info { flex: 1; min-width: 0; display: grid; gap: 4px; }
    .file-info strong { font-size: 13px; overflow-wrap: anywhere; }
    .file-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    progress { display: block; width: 100%; height: 5px; margin-top: 10px; accent-color: var(--accent); }
    .remove-confirm { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 12px; font-size: 12px; }
    .footnote { margin: 16px 0 0; line-height: 1.6; }
    @media (max-width: 600px) {
        .file-dropbox { padding: 16px; }
        .file-row { gap: 8px; }
        .section-heading > .field-help { display: none; }
    }
</style>
