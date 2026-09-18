// Maximize the area of 16:9 desktops while keeping every tile inside the player.
export function desktopLayout(count, width, height, gap = 8) {
    let best = {columns: 1, rows: Math.max(1, count)};
    let largest = -1;
    for (let columns = 1; columns <= count; columns++) {
        const rows = Math.ceil(count / columns);
        const size = Math.min((width - gap * (columns - 1)) / columns / (16 / 9),
            (height - gap * (rows - 1)) / rows);
        if (size > largest) {
            largest = size;
            best = {columns, rows};
        }
    }
    return best;
}
