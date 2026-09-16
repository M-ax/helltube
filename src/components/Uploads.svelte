<script>
    import Icon from './Icon.svelte';
    import {bytes, time} from '../lib/format.js';

    export let manager;
    const transfers = manager.transfers;
    let fileInput;
    let resumeId;
    let error = '';
    const labels = {
        checking: 'Checking saved offset',
        uploading: 'Uploading',
        pacing: 'Paced by the server',
        waiting: 'Waiting for preparation',
        paused: 'Paused on this device',
        retrying: 'Reconnecting upload',
        'needs-file': 'Reselect file to resume',
        complete: 'Upload complete',
        error: 'Upload needs attention',
        cancelling: 'Cancelling',
    };

    function resume(item) {
        error = '';
        if (item.file) manager.resume(item.id);
        else {
            resumeId = item.id;
            fileInput.click();
        }
    }

    function reselect(event) {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) return;
        try {
            manager.resume(resumeId, file);
        } catch (cause) {
            error = cause.message;
        }
    }
</script>

{#if $transfers.length}
    <section class="uploads-panel" aria-label="Your uploads">
        <div class="section-heading">
            <h3>
                <Icon name="upload" size={18}/>
                Your transfers<span class="count">{$transfers.filter((item) => item.state !== 'complete').length}</span>
            </h3>
            <span class="field-help">LOCAL TO THIS DEVICE</span></div>
        <input bind:this={fileInput} type="file" class="sr-only" tabindex="-1"
               aria-label="Reselect the original file to resume uploading" on:change={reselect}/>
        {#if error}<p class="form-error" role="alert">{error}</p>{/if}
        <ul class="transfer-list">
            {#each $transfers as item (item.id)}
                <li class="transfer-item">
                    <div class="transfer-top"><span class="transfer-icon" class:complete={item.state === 'complete'}><Icon
                            name={item.state === 'complete' ? 'check' : 'file'} size={21}/></span>
                        <div class="transfer-title"><strong>{item.name}</strong><span>{item.roomName} <span
                                class="separator">/</span> {labels[item.state]}</span></div>
                        <span class="transfer-percent">{Math.min(100, Math.floor((item.received || 0) / item.size * 100))}
                            %</span>
                        <div class="transfer-actions">
                            {#if ['paused', 'needs-file', 'error'].includes(item.state)}
                                <button class="icon-button" aria-label={`Resume upload of ${item.name}`}
                                        title={item.file ? 'Resume upload' : 'Reselect original file'}
                                        on:click={() => resume(item)}>
                                    <Icon name="play" size={17}/>
                                </button>
                            {:else if !['complete', 'cancelling'].includes(item.state)}
                                <button class="icon-button" aria-label={`Pause upload of ${item.name}`}
                                        title="Pause upload" on:click={() => manager.pause(item.id)}>
                                    <Icon name="pause" size={17}/>
                                </button>
                            {/if}
                            {#if item.state === 'complete'}
                                <button class="icon-button" aria-label={`Dismiss completed upload ${item.name}`}
                                        title="Dismiss transfer (keeps video in queue)"
                                        on:click={() => manager.dismiss(item.id)}>
                                    <Icon name="close" size={17}/>
                                </button>
                            {:else}
                                <button class="icon-button danger" disabled={item.state === 'cancelling'}
                                        aria-label={`Cancel upload and remove ${item.name} from queue`}
                                        title="Cancel upload and remove from queue"
                                        on:click={() => manager.cancel(item.id)}>
                                    <Icon name="close" size={17}/>
                                </button>
                            {/if}
                        </div>
                    </div>
                    <progress max={item.size} value={item.received || 0}
                              aria-label={`Upload progress for ${item.name}`}></progress>
                    <div class="transfer-stats"><span>{bytes(item.received || 0)} / {bytes(item.size)}</span><span>{#if item.rate > 0}{bytes(item.rate)}
                        /s transfer · {/if}
                        {#if item.state === 'complete'}Ready for media preparation{:else if item.state === 'needs-file'}File contents stay on your device{:else if item.active === false}Prepares when current or next{:else if Number.isFinite(item.bufferSeconds)}{time(item.bufferSeconds)}
                            buffered{/if}</span></div>
                    {#if item.slow && item.state !== 'complete'}
                        <p class="inline-note">
                            <Icon name="info" size={14}/>
                            The server reports a slow upload. Playback may wait for more data.
                        </p>
                    {/if}
                    {#if item.error}<p class="form-error"
                                       role={item.state === 'error' ? 'alert' : 'status'}>{item.error}</p>{/if}
                </li>
            {/each}
        </ul>
        <p class="field-help transfer-footnote">Transfer speed excludes server-requested waits. Keep this tab open, or
            reselect the original file later to resume.</p>
    </section>
{/if}