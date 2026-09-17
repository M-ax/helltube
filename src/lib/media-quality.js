export function availableQualities(media) {
    return media?.qualities?.length ? media.qualities : media ? [{...media, id: 'standard', label: 'Standard (up to 720p)'}] : [];
}

export function qualityReady(quality, position) {
    return position >= quality.baseTime && (quality.complete || position < quality.bufferedUntil - 0.5);
}

export function selectQuality(media, preference, position) {
    const qualities = availableQualities(media);
    return qualities.find(quality => quality.id === preference && qualityReady(quality, position)) ||
        qualities.find(quality => quality.url === media.url && qualityReady(quality, position)) ||
        qualities.find(quality => qualityReady(quality, position)) || media;
}
