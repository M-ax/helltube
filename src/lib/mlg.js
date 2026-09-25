export const MLG_LEAD_MS = 600;
export const MLG_LIFETIME_MS = 6600;

// Soft chroma key also removes compression fringes and green spill.
export function keyGreen(data) {
    for (let i = 0; i < data.length; i += 4) {
        const other = Math.max(data[i], data[i + 2]);
        const excess = data[i + 1] - other;
        if (excess <= 18) continue;
        data[i + 3] = Math.round(data[i + 3] * Math.max(0, 1 - (excess - 18) / 55));
        data[i + 1] = Math.min(data[i + 1], other + 18);
    }
    return data;
}
