<script>
    import Modal from './Modal.svelte';

    export let load;
    export let label = 'content';
    export let dialog = false;
    let pending = load();
</script>

{#snippet status(failed = false)}
    {#if failed}
        <div role="alert">
            <p>Could not load {label}. Check your connection and try again.</p>
            <button class="button secondary" on:click={() => pending = load()}>Retry loading {label}</button>
        </div>
    {:else}
        <p role="status">Loading {label}…</p>
    {/if}
{/snippet}

{#await pending}
    {#if dialog}
        <Modal title={`Loading ${label}`} onClose={$$restProps.onClose}>{@render status()}</Modal>
    {:else}
        <div class="lazy-status">{@render status()}</div>
    {/if}
{:then component}
    <svelte:component this={component.default} {...$$restProps}/>
{:catch}
    {#if dialog}
        <Modal title={`Could not load ${label}`} onClose={$$restProps.onClose}>{@render status(true)}</Modal>
    {:else}
        <div class="lazy-status">{@render status(true)}</div>
    {/if}
{/await}

<style>
    .lazy-status { padding: 24px; }
</style>
