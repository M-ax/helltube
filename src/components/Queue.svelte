<script>
    import Icon from './Icon.svelte';
    import {imageUrl, time} from '../lib/format.js';
    import {sourceLabels, sourceIcons} from '../../shared/media-source.js';

    export let room = null;
    export let connected = false;
    export let onCommand;
    export let onAdd;
    let tab = 'queue';
    $: queue = room?.queue || [];
    $: groups = queue.reduce((groups, item, index) => {
        const previous = groups[groups.length - 1];
        // Group adjacent playlist videos without changing the playback order.
        if (item.playlistId && previous?.playlistId === item.playlistId) {
            previous.entries.push({item, index});
        } else {
            groups.push({id: item.id, playlistId: item.playlistId, title: item.playlistTitle || 'Playlist',
                entries: [{item, index}]});
        }
        return groups;
    }, []);
    $: history = (room?.history || []).slice(0, 5);
    const statuses = {
        queued: 'In line',
        uploading: 'Uploading',
        processing: 'Preparing',
        ready: 'Ready to play',
        error: 'Needs attention'
    };
</script>

<aside class="queue-panel" aria-label="Room queue and watch history">
    <div class="queue-header">
        <div><p class="eyebrow">KEEP THE GOOD STUFF COMING</p>
            <h2>On the lineup<span class="accent">.</span></h2></div>
        <button class="icon-button bordered" aria-label="Add a video to the queue" disabled={!connected}
                on:click={onAdd}>
            <Icon name="plus" size={19}/>
        </button>
    </div>
    <div class="queue-tabs" role="group" aria-label="Queue view">
        <button class:active={tab === 'queue'} aria-pressed={tab === 'queue'} on:click={() => tab = 'queue'}>
            <Icon name="list" size={16}/>
            Up next<span class="count">{queue.length}</span></button>
        <button class:active={tab === 'history'} aria-pressed={tab === 'history'} on:click={() => tab = 'history'}>
            <Icon name="history" size={16}/>
            History<span class="count">{history.length}</span></button>
    </div>
    <div class="queue-content">
        {#if tab === 'queue'}
            {#if room?.current}
                <div class="current-queue-item"><span class="equalizer" class:still={room.playback.paused || !connected}
                                                      aria-hidden="true"><i></i><i></i><i></i></span>
                    <div><p class="eyebrow">ON SCREEN</p><strong>{room.current.title}</strong></div>
                    <span class="tag">{room.playback.paused ? 'Paused' : 'Now'}</span></div>
            {/if}
            {#if !queue.length}
                <div class="queue-empty"><span class="empty-lineup-art" aria-hidden="true"><Icon name="list" size={34}
                                                                                                 stroke={1.2}/></span>
                    <h3>{room?.current ? 'The encore is up to you.' : 'A fresh lineup.'}</h3>
                    <p>{room?.current ? 'Keep the night going. Add the next thing you can’t wait to share.' : 'Drop in that video you’ve been saving for the group.'}</p>
                    <button class="text-button" disabled={!connected} on:click={onAdd}>Add a video
                        <Icon name="plus" size={16}/>
                    </button>
                </div>
            {:else}
                <ol class="queue-list">
                    {#each groups as group (group.id)}
                        <li class:playlist-card={!!group.playlistId}>
                            {#if group.playlistId}
                                <div class="playlist-heading">
                                    <Icon name="list" size={15}/>
                                    <div>
                                        <strong>{group.title}</strong><span>{group.entries.length}
                                        queued in this playlist</span></div>
                                    <button class="icon-button danger" disabled={!connected}
                                            aria-label={`Remove all queued videos from ${group.title}`}
                                            title="Remove playlist from queue. The video on screen stays."
                                            on:click={() => onCommand({ type: 'queue:remove-playlist', playlistId: group.playlistId })}>
                                        <Icon name="trash" size={15}/>
                                    </button>
                                </div>
                                <ol class="playlist-videos" aria-label={group.title} start={group.entries[0].index + 1}>
                                    {#each group.entries as {item, index} (item.id)}
                                        <li>{@render queueEntry(item, index)}</li>
                                    {/each}
                                </ol>
                            {:else}
                                {@render queueEntry(group.entries[0].item, group.entries[0].index)}
                            {/if}
                        </li>
                    {/each}
                    {#snippet queueEntry(item, index)}
                            <div class="queue-item">
                                <div class="queue-thumb">
                                    {#if imageUrl(item.thumbnail)}<img src={imageUrl(item.thumbnail)} alt=""
                                                                       loading="lazy"
                                                                       referrerpolicy="no-referrer"/>{:else}
                                        <Icon name={sourceIcons[item.kind] || 'file'} size={25}
                                              stroke={1.3}/>
                                    {/if}<span>{time(item.duration)}</span></div>
                                <div class="queue-item-info"><span
                                        class="queue-index">{String(index + 1).padStart(2, '0')}
                                    / {(sourceLabels[item.kind] || 'Video').toUpperCase()}</span>
                                    <h3 title={item.title}>{item.title}</h3><span class="item-status"
                                                                                  class:status-error={item.status === 'error'}><i
                                            class={`item-dot ${item.status}`}></i>{statuses[item.status] || item.status}</span>
                                </div>
                            </div>
                            {#if item.error}<p class="queue-item-error">{item.error}</p>{/if}
                            <div class="queue-actions"><span
                                    class="queue-position">{index === 0 ? 'Plays next' : `Position ${index + 1}`}</span>
                                <button class="icon-button" aria-label={`Move ${item.title} up`} title="Move up"
                                        disabled={!connected || index === 0}
                                        on:click={() => onCommand({ type: 'queue:move', itemId: item.id, toIndex: index - 1 })}>
                                    <Icon name="up" size={16}/>
                                </button>
                                <button class="icon-button" aria-label={`Move ${item.title} down`} title="Move down"
                                        disabled={!connected || index === queue.length - 1}
                                        on:click={() => onCommand({ type: 'queue:move', itemId: item.id, toIndex: index + 1 })}>
                                    <Icon name="down" size={16}/>
                                </button>
                                <button class="icon-button danger" aria-label={`Remove ${item.title} from queue`}
                                        title="Remove from queue" disabled={!connected}
                                        on:click={() => onCommand({ type: 'queue:remove', itemId: item.id })}>
                                    <Icon name="close" size={16}/>
                                </button>
                            </div>
                    {/snippet}
                </ol>
            {/if}
        {:else}
            <p class="history-help">The last five watches. Bring one back to the screen for everyone.</p>
            {#if !history.length}
                <div class="queue-empty"><span class="empty-lineup-art"><Icon name="history" size={32}
                                                                              stroke={1.3}/></span>
                    <h3>The night is still young.</h3>
                    <p>Previously played videos will appear here.</p></div>
            {:else}
                <ol class="history-list">
                    {#each history as item (item.id)}
                        <li>
                            <button class="history-item" disabled={!connected}
                                    aria-label={`Play ${item.title} from history for everyone`}
                                    on:click={() => onCommand({ type: 'history:play', itemId: item.id })}><span
                                    class="history-thumb">{#if imageUrl(item.thumbnail)}<img
                                    src={imageUrl(item.thumbnail)} alt="" loading="lazy"
                                    referrerpolicy="no-referrer"/>{:else}<Icon name="film" size={22}/>{/if}<span
                                    class="history-play"><Icon name="play" size={16}/></span></span><span
                                    class="history-info"><strong>{item.title}</strong><span>{time(item.duration)}
                                · {sourceLabels[item.kind] || 'Video'}</span></span>
                                <Icon name="refresh" size={16}/>
                            </button>
                        </li>
                    {/each}
                </ol>
            {/if}
        {/if}
    </div>
    <footer class="queue-footer">
        <Icon name="users" size={17}/>
        <p>Good taste is a team sport.<span>Everyone can curate the queue.</span></p></footer>
</aside>
