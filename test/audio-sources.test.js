import test from 'node:test';
import assert from 'node:assert/strict';
import {SoundCloud} from '../server/soundcloud.js';
import {Spotify} from '../server/spotify.js';
import {Rooms, makeItem} from '../server/rooms.js';
import {sourceKind, soundcloudURL, spotifyLink} from '../shared/media-source.js';
import {start, until} from './helpers.js';

const spotifyURL = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';

test('audio provider URLs normalize without accepting credentials, ports, or forged hosts', () => {
    assert.equal(sourceKind('https://soundcloud.com/artist/track'), 'soundcloud');
    assert.equal(sourceKind(spotifyURL), 'spotify');
    assert.equal(soundcloudURL('http://www.soundcloud.com/artist/track?utm_source=share#t=1'), 'https://soundcloud.com/artist/track');
    assert.equal(soundcloudURL('https://on.soundcloud.com/abc123'), 'https://on.soundcloud.com/abc123');
    assert.equal(soundcloudURL('https://soundcloud.com/artist/sets/mix'), 'https://soundcloud.com/artist/sets/mix');
    assert.equal(spotifyLink(spotifyURL.replace('/track/', '/intl-de/embed/track/') + '?si=abc').url, spotifyURL);
    for (const value of ['https://soundcloud.com/artist', 'https://soundcloud.com/artist/sets', 'https://soundcloud.com.evil.test/a/b',
        'https://user:secret@soundcloud.com/a/b', 'https://soundcloud.com:444/a/b', 'file:///a/b']) assert.throws(() => soundcloudURL(value));
    for (const value of [spotifyURL.replace('open.spotify.com', 'open.spotify.com.evil.test'), spotifyURL.replace('https:', 'file:'),
        spotifyURL.replace('open.', 'user:secret@open.'), spotifyURL.replace('/track/', ':444/track/'), spotifyURL + '/extra',
        'https://open.spotify.com/user/me', 'https://open.spotify.com/track/nope']) assert.throws(() => spotifyLink(value));
});

test('SoundCloud playlist metadata is bounded, tracks resolve fresh CDN URLs, and non-CDN inputs are rejected', async t => {
    const provider = new SoundCloud({ytdlp: 'yt-dlp'});
    const track = {title: 'Song', webpage_url: 'https://soundcloud.com/artist/track', duration: 90, uploader: 'Artist',
        thumbnail: 'https://i1.sndcdn.com/art.jpg', url: 'https://cf-media.sndcdn.com/audio.mp3'};
    let data = {title: 'Mix', entries: [track, {...track, title: 'Second'}]};
    t.mock.method(provider, 'extract', async () => data);
    const items = await provider.items('https://soundcloud.com/artist/sets/mix', {displayName: 'Viewer'}, 10);
    assert.equal(items.length, 2);
    assert.equal(items[0].playlistId, items[1].playlistId);
    assert.deepEqual(items.map(item => item.startAt), [10, 0]);
    assert.equal(items[0].artist, 'Artist');
    assert.ok(items.every(item => item.audioOnly));
    data = track;
    assert.deepEqual((await provider.resolve(track.webpage_url)).inputs, [{url: track.url, headers: {}}]);
    for (const startAt of [-1, 0.1, null, '1', 90]) await assert.rejects(provider.items(track.webpage_url, {}, startAt), {status: 400});
    for (const url of ['http://cf-media.sndcdn.com/a.mp3', 'https://sndcdn.com.evil.test/a', 'https://127.0.0.1/a', 'file:///secret']) {
        data = {...track, url};
        await assert.rejects(provider.resolve(track.webpage_url), /unsupported media host/);
    }
});

test('SoundCloud track links inside playlists resolve the newer AAC playback host without widening host trust', async t => {
    const provider = new SoundCloud({ytdlp: 'yt-dlp'});
    const link = 'https://soundcloud.com/djblyatman/atom?in=aezeus/sets/magnitude-5-hardbass';
    const canonical = 'https://soundcloud.com/djblyatman/atom';
    const media = 'https://playback.media-streaming.soundcloud.cloud/track/585307245/playlist.m3u8?token=private';
    const data = {title: 'DJ Blyatman - Atom', duration: 265.65, webpage_url: canonical,
        format_id: 'hls_aac_160k', protocol: 'm3u8_native', acodec: 'mp4a.40.2', url: media};
    const extract = t.mock.method(provider, 'extract', async () => data);
    const [item] = await provider.items(link, {displayName: 'Listener'}, 0);
    assert.equal(item.source.url, canonical);
    assert.equal(item.playlistId, null, 'The in= parameter identifies the context, not an explicit playlist import.');
    assert.equal(extract.mock.calls[0].arguments[0], canonical);
    assert.deepEqual(await provider.resolve(item.source.url), {inputs: [{url: media, headers: {}}], duration: 265.65});
    for (const url of [media.replace('https:', 'http:'), media.replace('.cloud/', '.cloud.evil.test/'),
        media.replace('playback.media-streaming.', 'untrusted.'), media.replace('https://', 'https://user:pass@'),
        media.replace('.cloud/', '.cloud:444/')]) {
        data.url = url;
        await assert.rejects(provider.resolve(canonical), /unsupported media host/);
    }
});

test('Spotify survives unavailable metadata and stays outside the room playback clock', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline'); });
    const provider = new Spotify();
    const [item] = await provider.items(spotifyURL, {displayName: 'Listener'});
    assert.equal(item.title, 'Spotify track');
    assert.equal(item.status, 'ready');
    await assert.rejects(provider.items(spotifyURL, {}, 1), {status: 400});
    const rooms = new Rooms();
    const room = rooms.get('lobby');
    const next = makeItem({kind: 'http', url: 'https://example.com/song.mp3'});
    rooms.add(room, [item, next]);
    for (let i = 0; i < 10; i++) rooms.tick();
    assert.equal(room.current.id, item.id);
    assert.equal(room.playback.paused, true);
    assert.equal(rooms.snapshot(room).current.embed, spotifyLink(spotifyURL).embed);
    assert.equal(rooms.snapshot(room).current.source, undefined);
    for (const action of ['play', 'pause', 'seek']) assert.throws(() => rooms.control(room, {action, revision: room.playback.revision, position: 5}), /Spotify player/);
    rooms.control(room, {action: 'skip', revision: room.playback.revision});
    assert.equal(room.current.id, next.id);
    rooms.control(room, {action: 'previous', revision: room.playback.revision});
    assert.equal(room.current.id, item.id);
});

test('media API queues audio providers and Spotify never starts a transcoder', async t => {
    const {instance, api, connect} = await start(t);
    const ws = await connect();
    ws.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    await until(() => instance.rooms.get('lobby').members.size);
    t.mock.method(instance.spotify, 'items', async () => [makeItem({kind: 'spotify', url: spotifyURL}, {status: 'ready', audioOnly: true})]);
    instance.capabilities.ffmpeg = false;
    const response = await api('/api/rooms/lobby/media', {method: 'POST', body: {url: spotifyURL}});
    assert.equal(response.status, 201);
    instance.media.schedule();
    assert.equal(instance.media.jobs.size, 0);
    assert.equal(instance.rooms.snapshot(instance.rooms.get('lobby')).current.embed, spotifyLink(spotifyURL).embed);
    instance.capabilities.ffmpeg = true;
    instance.capabilities.soundcloud = true;
    t.mock.method(instance.soundcloud, 'items', async () => [makeItem({kind: 'soundcloud', url: 'https://soundcloud.com/artist/track'}, {audioOnly: true})]);
    // Keep this integration focused on routing, without starting an external extraction.
    t.mock.method(instance.media, 'schedule', () => {});
    assert.equal((await api('/api/rooms/lobby/media', {method: 'POST', body: {url: 'https://soundcloud.com/artist/track'}})).status, 201);
    assert.equal(instance.rooms.get('lobby').queue[0].kind, 'soundcloud');
});
