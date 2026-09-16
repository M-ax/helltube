<script>
    import {onMount} from 'svelte';
    import Icon from './Icon.svelte';

    export let title;
    export let subtitle = '';
    export let onClose;
    export let wide = false;
    let dialog;

    onMount(() => {
        const previous = document.activeElement;
        dialog.showModal();
        dialog.querySelector('[data-initial-focus]')?.focus();
        return () => {
            dialog?.close();
            previous?.focus();
        };
    });
</script>

<dialog bind:this={dialog} class:wide class="dialog" aria-label={title}
        on:cancel={(event) => { event.preventDefault(); onClose(); }}>
    <div class="dialog-inner">
        <header class="dialog-heading">
            <div><p class="eyebrow">YOUR CORNER OF HELLTUBE</p>
                <h2>{title}</h2>
                {#if subtitle}<p class="muted">{subtitle}</p>{/if}
            </div>
            <button class="icon-button" aria-label="Close dialog" on:click={onClose}>
                <Icon name="close"/>
            </button>
        </header>
        <slot/>
    </div>
</dialog>