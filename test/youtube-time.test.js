import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStartTime, youtubeTimeArgument } from '../shared/youtube-time.js';
import { YouTube } from '../server/youtube.js';

test('start times accept seconds, YouTube units and editable clock times without partial parsing', () => {
  for (const [value, expected] of [['0', 0], ['90', 90], ['90s', 90], ['1m30s', 90], ['2h', 7200],
    ['1h2m3s', 3723], ['1h3s', 3603], ['1:30', 90], ['90:00', 5400], ['1:02:03', 3723], [' 2M ', 120]]) {
    assert.equal(parseStartTime(value), expected, value);
  }
  for (const value of ['', ' ', '-1', '1.5', '1:60', '1:2', '1:02:60', '1:02:03:04', '1e3', 'Infinity',
    'NaN', '30seconds', '1s2m', '1m1m', '1h30', '9007199254740992', '999999999999999999999h', null, 30]) {
    assert.equal(parseStartTime(value), null, String(value));
  }
});

test('YouTube query timestamps are detected independently of parameter position and unrelated parameters', () => {
  for (const url of ['https://www.youtube.com/watch?v=BaW_jenozKc&t=1m30s',
    'https://youtu.be/BaW_jenozKc?t=1m30s&si=share', 'https://youtube.com/shorts/BaW_jenozKc?t=1m30s',
    'https://youtube.com/watch?t=1m30s&v=BaW_jenozKc']) {
    assert.equal(youtubeTimeArgument(url), '1m30s');
  }
  assert.equal(youtubeTimeArgument('https://youtu.be/BaW_jenozKc?t='), '');
  assert.equal(youtubeTimeArgument('https://youtu.be/BaW_jenozKc?t=bad'), 'bad');
  assert.equal(youtubeTimeArgument('https://youtu.be/BaW_jenozKc?not=90'), null);
  assert.equal(youtubeTimeArgument('not a URL'), null);
});

test('YouTube items preserve detected starts, explicit edits and an unchecked zero override', async t => {
  const youtube = new YouTube({});
  const extract = t.mock.method(youtube, 'extract', async () => ({ id: 'BaW_jenozKc', duration: 300 }));
  const url = 'https://www.youtube.com/watch?v=BaW_jenozKc&t=1m30s';
  const user = { displayName: 'Viewer' };
  for (const [override, expected] of [[undefined, 90], [125, 125], [0, 0]]) {
    const [item] = await youtube.items(url, user, override);
    assert.equal(item.startAt, expected);
    assert.equal(item.source.startAt, expected);
    assert.equal(item.source.url, 'https://www.youtube.com/watch?v=BaW_jenozKc');
  }
  assert.equal((await youtube.items(url.split('&')[0], user))[0].startAt, 0);
  assert.equal(extract.mock.calls[0].arguments[0].at(-1), 'https://www.youtube.com/watch?v=BaW_jenozKc');
  for (const invalid of [-1, 1.5, Infinity, NaN, null, '30', true, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(youtube.items(url, user, invalid), error => error.status === 400 && /start time/i.test(error.message));
  }
  for (const suffix of ['&t=bad', '&t=', '&t=-10']) {
    await assert.rejects(youtube.items(url.split('&')[0] + suffix, user), /start time/i);
  }
  await assert.rejects(youtube.items(url, user, 300), /before the end/i);
  await assert.rejects(youtube.items(url, user, 500), /before the end/i);
});

test('playlist timestamps apply only to the linked video or first playable entry, not every entry', async t => {
  const youtube = new YouTube({});
  t.mock.method(youtube, 'extract', async () => ({ title: 'Playlist', entries: [null,
    { id: 'abcdefghijk', availability: 'private' },
    { id: 'jNQXAC9IVRw', duration: 60 }, { id: 'BaW_jenozKc', duration: 120 },
  ] }));
  const user = { displayName: 'Viewer' };
  const linked = await youtube.items('https://youtube.com/watch?v=BaW_jenozKc&list=PL1234567890123&t=90', user);
  assert.deepEqual(linked.map(item => item.startAt), [0, 90]);
  assert.ok(linked[0].playlistId && linked[0].playlistId === linked[1].playlistId);
  const playlist = await youtube.items('https://youtube.com/playlist?list=PL1234567890123&t=30', user);
  assert.deepEqual(playlist.map(item => item.startAt), [30, 0]);
});