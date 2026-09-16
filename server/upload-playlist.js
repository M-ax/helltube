export function inferPlaylistTitle(names) {
  const words = names.map(name => (name.replace(/\.[^.]+$/u, '').normalize('NFKC')
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).flatMap(word => {
    const numbered = /^(\p{L}{2,})(\p{N}+)$/u.exec(word);
    return numbered ? [numbered[1], numbered[2]] : [word];
  }));
  if (!words.length || words.some(value => !value.length)) return 'Uploaded videos';
  const searchable = words.map(value => `\0${value.join('\0').toLowerCase()}\0`);
  const candidates = [];
  for (let start = 0; start < words[0].length; start++) {
    for (let end = start + 1; end <= words[0].length; end++) {
      const phrase = words[0].slice(start, end);
      const title = phrase.join(' ');
      if (/\p{L}/u.test(title)) candidates.push({ title, key: `\0${phrase.join('\0').toLowerCase()}\0` });
    }
  }
  candidates.sort((a, b) => b.title.length - a.title.length);
  return candidates.find(candidate => searchable.every(value => value.includes(candidate.key)))?.title || 'Uploaded videos';
}