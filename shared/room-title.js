export function roomNowPlayingTitle(room) {
  if (room?.current?.kind !== 'desktop') return room?.current?.title || null;
  const desktops = room.desktops?.length ? room.desktops : [room.current];
  const names = [...new Set(desktops.map(item => item.sharedByUsername || item.addedBy).filter(Boolean))];
  if (!names.length) return room.current.title;
  return names.length === 1 ? `${names[0]}’s desktop` : `Desktops: ${names.join(', ')}`;
}
