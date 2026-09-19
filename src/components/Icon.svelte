<script>
    export let name;
    export let size = 20;
    export let stroke = 1.7;

    const paths = {
        play: 'm9 5 11 7-11 7Z',
        pause: 'M8 5v14M16 5v14',
        next: 'm4 5 10 7-10 7ZM19 5v14',
        previous: 'm20 5-10 7 10 7ZM5 5v14',
        plus: 'M12 5v14M5 12h14',
        close: 'm6 6 12 12M6 18 18 6',
        chevron: 'm9 5 7 7-7 7',
        up: 'm6 14 6-6 6 6',
        down: 'm6 10 6 6 6-6',
        room: 'M4 10h16M3 16h16M10 3 6 21M18 3l-4 18',
        users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
        user: 'M20 21v-2a7 7 0 0 0-14 0v2M17 7A5 5 0 1 1 7 7a5 5 0 0 1 10 0Z',
        settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
        logout: 'M9 4H4v16h5M9 12h12m-4-4 4 4-4 4',
        shield: 'M12 3 3 7v6c0 4 9 8 9 8s9-4 9-8V7ZM9 12l2 2 4-4',
        trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
        edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z',
        link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
        external: 'M14 3h7v7M10 14 21 3M10 3H3v18h18v-7',
        unlink: 'm18 13 2-2a5 5 0 0 0-7-7l-2 2M6 11l-2 2a5 5 0 0 0 7 7l2-2M8 2v3M2 8h3M16 19v3M19 16h3',
        youtube: 'm10 8 6 4-6 4ZM21 7v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z',
        twitch: 'M4 3h17v12l-5 5h-5l-4 3v-3H3V6ZM10 7v6M16 7v6',
        music: 'M9 18V5l12-2v13M9 8l12-2M9 18a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3ZM21 16a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3Z',
        upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
        desktop: 'M2 3h20v14H2ZM8 21h8M12 17v4',
        file: 'M14 2H4v20h16V8ZM14 2v6h6M8 13l7 4-7 3Z',
        list: 'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1',
        history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2',
        volume: 'M11 4 6 8H2v8h4l5 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14',
        mute: 'M11 4 6 8H2v8h4l5 4ZM16 9l6 6M16 15l6-6',
        fullscreen: 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5',
        check: 'm5 12 4 4L19 6',
        warning: 'm12 3 10 18H2ZM12 9v5M12 17h.01',
        info: 'M12 11v6M12 7h.01M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0Z',
        refresh: 'M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6',
        wifi: 'M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0M12 20h.01',
        offline: 'm3 3 18 18M2 8a16 16 0 0 1 4-2M10 4a16 16 0 0 1 12 4M5 12a11 11 0 0 1 4-2M14 10a11 11 0 0 1 5 2M8 16a6 6 0 0 1 8 0M12 20h.01',
        film: 'M3 3h18v18H3ZM7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M7 12h10',
        flame: 'M13 2c1 6-5 6-3 11 1-1 3-2 3-4 5 3 8 7 5 11-3 4-11 3-13-2C1 10 10 9 13 2Z',
        clock: 'M12 6v6l4 2M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0Z',
    };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke}
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={paths[name] || paths.film}/>
</svg>
