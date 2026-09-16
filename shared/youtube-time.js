export function parseStartTime(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  let seconds;
  if (/^\d+$/.test(text)) seconds = Number(text);
  else if (/^\d+(?::[0-5]\d){1,2}$/.test(text)) {
    seconds = text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  } else {
    const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
    if (!text || !match) return null;
    seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  }
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

export function youtubeTimeArgument(value) {
  try { return new URL(value).searchParams.get('t'); }
  catch { return null; }
}