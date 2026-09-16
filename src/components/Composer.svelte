<script>
    import {tick} from 'svelte';
    import Icon from './Icon.svelte';
    import SeekJoystick from './SeekJoystick.svelte';
    import {api} from '../lib/api.js';
    import {isYoutubeUrl, time} from '../lib/format.js';
    import {videoFileAccept} from '../lib/uploads.js';
    import {parseStartTime, youtubeTimeArgument} from '../../shared/youtube-time.js';

    export let room = null;
    export let connected = false;
    export let capabilities = {};
    export let manager;
    export let notify;
    let mode = 'youtube';
    let url = '';
    let insertAt = 'end';
    let busy = '';
    let error = '';
    let hasStartTime = false;
    let startTimeEnabled = false;
    let startTimeText = '';
    let startTimeError = '';
    let fileInput;
    let urlInput;
    let section;
    let filesDragDepth = 0;
    let dropzoneDragDepth = 0;
    $: queue = room?.queue || [];
    $: if (insertAt !== 'end' && Number(insertAt) >= queue.length) insertAt = 'end';
    $: unavailable = !connected || !room || capabilities.ffmpeg === false;
    $: youtubeUnavailable = unavailable || capabilities.youtube === false || !!busy;
    $: uploadUnavailable = unavailable || !!busy || !manager;
    $: if (uploadUnavailable) resetFileDrag();
    $: if (mode !== 'upload') dropzoneDragDepth = 0;
    $: resetStartTime(url);

    function resetStartTime(value) {
        const argument = isYoutubeUrl(value.trim()) ? youtubeTimeArgument(value.trim()) : null;
        const seconds = argument === null ? null : parseStartTime(argument);
        hasStartTime = argument !== null;
        startTimeEnabled = hasStartTime;
        startTimeText = seconds === null ? argument ?? '' : time(seconds);
        startTimeError = '';
    }

    function readStartTime() {
        const seconds = parseStartTime(startTimeText);
        startTimeError = seconds === null
            ? 'Enter a valid start time: seconds, m:ss, h:mm:ss, or 1h2m3s (nonnegative safe integer seconds).'
            : '';
        return seconds;
    }

    function normalizeStartTime() {
        if (!startTimeEnabled || youtubeUnavailable) return;
        const seconds = readStartTime();
        if (seconds !== null) startTimeText = time(seconds);
    }

    function adjustStartTime(delta) {
        if (!hasStartTime || !startTimeEnabled || youtubeUnavailable) return;
        const seconds = readStartTime();
        if (seconds === null) return;
        const adjusted = Math.max(0, seconds + delta);
        if (!Number.isSafeInteger(adjusted)) {
            startTimeError = 'Start time cannot exceed 9,007,199,254,740,991 seconds.';
            return;
        }
        startTimeText = time(adjusted);
    }

    export async function focus() {
        section?.scrollIntoView({behavior: 'smooth', block: 'center'});
        await tick();
        if (mode === 'youtube') urlInput?.focus({preventScroll: true});
        else section?.querySelector('.upload-choose')?.focus({preventScroll: true});
    }

    function position() {
        return insertAt === 'end' ? queue.length : Number(insertAt);
    }

    async function addYoutube() {
        if (busy || unavailable || capabilities.youtube === false) return;
        error = '';
        if (!isYoutubeUrl(url.trim())) {
            error = 'Paste a complete youtube.com or youtu.be video or playlist URL.';
            return;
        }
        const startAt = hasStartTime && startTimeEnabled ? readStartTime() : 0;
        if (startAt === null) return;
        const roomId = room.id;
        const roomName = room.name;
        busy = 'youtube';
        try {
            const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/youtube`, {
                method: 'POST',
                body: {url: url.trim(), insertAt: position(), startAt}
            });
            url = '';
            notify(`${result.added} ${result.added === 1 ? 'video' : 'videos'} added to ${roomName}.`, 'notice');
        } catch (cause) {
            error = cause.message;
        } finally {
            busy = '';
        }
    }

    async function chooseFile(event) {
        const files = Array.from(event.currentTarget.files || []);
        event.currentTarget.value = '';
        await addFiles(files);
    }

    async function addFiles(files) {
        if (!files.length || busy || uploadUnavailable) return;
        const selectedRoom = {id: room.id, name: room.name};
        const selectedPosition = position();
        busy = 'upload';
        resetFileDrag();
        error = '';
        try {
            const result = await manager.addMany(files, selectedRoom, selectedPosition);
            notify(files.length === 1
                ? `“${files[0].name}” joined the lineup in ${selectedRoom.name}.`
                : `Playlist “${result.playlistTitle}” (${files.length} videos) joined the lineup in ${selectedRoom.name}.`, 'notice');
        } catch (cause) {
            if (cause.name !== 'AbortError') error = cause.message;
        } finally {
            busy = '';
        }
    }

    function isFileDrag(event) {
        return Array.from(event.dataTransfer?.types || []).includes('Files') ||
            Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file') ||
            !!event.dataTransfer?.files?.length;
    }

    function resetFileDrag() {
        filesDragDepth = 0;
        dropzoneDragDepth = 0;
    }

    function dragOver(event) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = uploadUnavailable ? 'none' : 'copy';
    }

    function dragEnter(event, target) {
        if (!isFileDrag(event)) return;
        dragOver(event);
        if (uploadUnavailable) return;
        if (target === 'files') filesDragDepth++;
        else dropzoneDragDepth++;
    }

    function dragLeave(event, target) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (target === 'files') filesDragDepth = Math.max(0, filesDragDepth - 1);
        else dropzoneDragDepth = Math.max(0, dropzoneDragDepth - 1);
    }

    function dropFiles(event) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        resetFileDrag();
        if (uploadUnavailable) return;
        const files = Array.from(event.dataTransfer.files || []);
        if (!files.length) return;
        mode = 'upload';
        void addFiles(files);
    }

    function preventFileDrop(event) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'none';
        resetFileDrag();
    }

    function leaveWindow(event) {
        if (isFileDrag(event) && !event.relatedTarget) resetFileDrag();
    }
</script>

<svelte:window on:dragover={preventFileDrop} on:drop={preventFileDrop} on:dragleave={leaveWindow}
               on:dragend={resetFileDrag} on:blur={resetFileDrag}/>

<section class="composer" bind:this={section} aria-label="Add a video">
    <div class="composer-heading">
        <div><span class="eyebrow">FOUND SOMETHING GOOD?</span>
            <h3>Pass the popcorn. Add a video.</h3></div>
        <div class="source-switch" role="group" aria-label="Video source">
            <button class:active={mode === 'youtube'} aria-pressed={mode === 'youtube'}
                    on:click={() => mode = 'youtube'}>
                <Icon name="youtube" size={17}/>
                <span>YouTube</span></button>
            <button class:active={mode === 'upload'} class:drag-active={filesDragDepth > 0 && !uploadUnavailable}
                    aria-pressed={mode === 'upload'} title="Choose videos or drop files here"
                    on:click={() => mode = 'upload'} on:dragenter={event => dragEnter(event, 'files')}
                    on:dragover={dragOver} on:dragleave={event => dragLeave(event, 'files')} on:drop={dropFiles}>
                <Icon name="upload" size={16}/>
                <span>Your files</span></button>
        </div>
    </div>
    {#if mode === 'youtube'}
        <form class="youtube-form" on:submit|preventDefault={addYoutube}>
            <label for="youtube-url" class="sr-only">YouTube video or playlist URL</label>
            <div class="url-field">
                <Icon name="link" size={18}/>
                <input id="youtube-url" bind:this={urlInput} bind:value={url} type="url"
                       placeholder="Paste a YouTube video or playlist link" required
                       disabled={youtubeUnavailable} autocomplete="off"/></div>
            {#if hasStartTime}
                <div class="youtube-start-time">
                    <label><input type="checkbox" bind:checked={startTimeEnabled} aria-label="Start at"
                                  disabled={youtubeUnavailable} on:change={() => startTimeError = ''}/>Start at</label>
                    <input id="youtube-start-time" type="text" bind:value={startTimeText}
                           aria-label="Video start time" aria-invalid={!!startTimeError}
                           aria-describedby={startTimeEnabled && startTimeError ? 'youtube-start-time-error' : undefined}
                           disabled={youtubeUnavailable || !startTimeEnabled} autocomplete="off" spellcheck={false}
                           on:input={() => startTimeError = ''} on:blur={normalizeStartTime}/>
                    {#key url}
                        <SeekJoystick disabled={youtubeUnavailable || !startTimeEnabled}
                                      ariaLabel="Start time joystick" commitLabel="adjust start time"
                                      onSeek={adjustStartTime}/>
                    {/key}
                </div>
                {#if startTimeEnabled && startTimeError}
                    <p id="youtube-start-time-error" class="form-error" role="alert">
                        <Icon name="warning" size={16}/>{startTimeError}</p>
                {/if}
            {/if}
            <button class="button primary" type="submit"
                    disabled={youtubeUnavailable}>
                {#if busy === 'youtube'}<span class="spinner"></span>Adding…
                {:else}
                    <Icon name="plus" size={18}/>
                    Add to queue
                {/if}
            </button>
        </form>
        {#if busy === 'youtube'}<p class="field-help" role="status">Finding the videos and expanding the playlist. This
            can take a minute; please don’t submit it again.</p>{/if}
    {:else}
        <div class="upload-dropzone" class:drag-active={dropzoneDragDepth > 0 && !uploadUnavailable}
             role="group" aria-label="Upload local videos" aria-describedby="upload-help"
             aria-disabled={uploadUnavailable} aria-busy={busy === 'upload'}
             on:dragenter={event => dragEnter(event, 'dropzone')} on:dragover={dragOver}
             on:dragleave={event => dragLeave(event, 'dropzone')} on:drop={dropFiles}>
            <span class="upload-symbol"><Icon name="upload" size={23}/></span>
            <div><strong>Your device. The big screen.</strong>
                <p id="upload-help">Choose or drop up to 100 videos here or on Your files. Multiple files become a playlist
                    automatically named from their common filename text, ignoring extensions.</p></div>
            <button class="button secondary upload-choose" disabled={uploadUnavailable}
                    on:click={() => fileInput.click()}>
                {#if busy === 'upload'}<span class="spinner"></span>Reading videos…
                {:else}Choose videos
                    <Icon name="plus" size={16}/>
                {/if}
            </button>
        </div>
        <input class="sr-only" tabindex="-1" aria-label="Select a local video to upload" type="file"
               multiple accept={videoFileAccept} bind:this={fileInput} on:change={chooseFile}
               disabled={uploadUnavailable}/>
    {/if}
    <div class="composer-bottom">
        <p>{mode === 'youtube' ? 'Videos, Shorts, or a whole playlist. Up to 200 videos.' : 'Playback can start while uploading, when the container allows.'}</p>
        <label for="insert-position">Insert<select id="insert-position" bind:value={insertAt}
                                                   disabled={unavailable || !!busy}>
            <option value="end">At the end</option>
            {#each queue as entry, index (entry.id)}
                <option value={String(index)}>{index === 0 ? 'Play next' : `At position ${index + 1}`}</option>
            {/each}
        </select></label></div>
    {#if error}
        <p class="form-error" role="alert">
            <Icon name="warning" size={16}/>{error}</p>
    {/if}
    {#if mode === 'youtube' && capabilities.youtube === false}<p class="inline-note">YouTube is unavailable because
        yt-dlp is missing on the server. Ask your administrator to install it.</p>{/if}
    {#if mode === 'upload'}
        <details class="upload-explainer">
            <summary>How uploading and buffering work</summary>
            <p>Only one chunk per file is sent at a time. The server adapts the delay to the playback buffer, rather
                than imposing a fixed bandwidth limit. Only the current and next videos are prepared, so later files
                wait their turn.</p>
            <p>MP4/MOV and other containers with an index at the end may need the entire upload before they can play.
                Keep this page open; after a reload, reselect the same unchanged file to resume from the server’s saved
                offset.</p></details>
    {/if}
</section>