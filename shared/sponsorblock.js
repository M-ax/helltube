// Positions remain on the original video timeline, including after an HLS restart.
export function sponsorPosition(item, position, elapsed = 0) {
  let target = position + elapsed;
  if (item?.kind !== 'youtube') return target;
  for (const [start, end] of item.sponsorSegments || []) {
    if (position < end && target >= start) target += end - Math.max(position, start);
  }
  return target;
}

export function sponsorContains(segments, start, end) {
  return segments.some(([from, to]) => start >= from && end <= to);
}
