import {defineConfig} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';

export default defineConfig({base: './', plugins: [svelte()],
    build: {target: 'chrome140', outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0},
    resolve: {dedupe: ['svelte']}});
