import test from 'node:test';
import assert from 'node:assert/strict';
import {startupRows, terminalBar} from '../src/lib/player-startup.js';
import {createProgressReader} from '../server/media-progress.js';

test('FFmpeg progress survives split records, ignores unavailable values, and exposes only numeric metrics', () => {
    const records = [];
    const read = createProgressReader(record => records.push(record));
    read(Buffer.from('frame=20\nout_time_us=12'));
    read(Buffer.from('50000\nspeed=2.5x\nprogress=cont'));
    assert.equal(records.length, 0);
    read(Buffer.from('inue\r\nout_time_us=N/A\nspeed=N/A\nprogress=continue\nout_time_us=9000000\nspeed=3x\nprogress=end\n'));
    assert.deepEqual(records, [{seconds: 1.25, speed: 2.5}, {}, {seconds: 9, speed: 3}]);
});

test('idle, metadata, and queued startup states never fabricate work or percentages', () => {
    assert.deepEqual(startupRows(null, null, true).map(row => row.state), ['ok', 'ok', 'wait']);
    const metadata = startupRows(null, {stage: 'metadata', kind: 'youtube'}, true);
    assert.equal(metadata.find(row => row.id === 'metadata').state, 'busy');
    assert.equal(metadata.find(row => row.id === 'transcode').progress, undefined);
    const queued = startupRows({kind: 'http', status: 'queued'}, null, true);
    assert.equal(queued.find(row => row.id === 'transcode').state, 'wait');
});

test('concurrent uploading and transcoding report independent measured progress with seek offsets', () => {
    const rows = startupRows({kind: 'upload', status: 'processing', duration: 100,
        uploadProgress: {received: 256, total: 1024, complete: false},
        preparation: {stage: 'transcoding', baseTime: 80, seconds: 10, speed: 1.5}}, null, true);
    assert.equal(rows.find(row => row.id === 'upload').progress, 25);
    assert.equal(rows.find(row => row.id === 'transcode').progress, 50);
    assert.equal(rows.find(row => row.id === 'buffer').progress, 0);
    assert.equal(rows.find(row => row.id === 'playback').state, 'wait');
    assert.match(rows.find(row => row.id === 'transcode').detail, /1.5x/);
});

test('unknown durations stay indeterminate while the ten-second startup buffer builds', () => {
    const item = {kind: 'http', preparation: {stage: 'buffering', seconds: 2},
        media: {baseTime: 50, bufferedUntil: 52, complete: false}};
    const rows = startupRows(item, null, true);
    assert.equal(rows.find(row => row.id === 'transcode').progress, null);
    assert.equal(rows.find(row => row.id === 'buffer').progress, 20);
    assert.equal(rows.find(row => row.id === 'buffer').detail, '2.0 / 10.0 s');
    assert.equal(rows.find(row => row.id === 'playback').state, 'wait');
    item.media.bufferedUntil = 60;
    assert.equal(startupRows(item, null, true).find(row => row.id === 'playback').state, 'busy');
    item.media.bufferedUntil = 52;
    item.media.complete = true;
    assert.equal(startupRows(item, null, true).find(row => row.id === 'playback').state, 'busy');
    assert.equal(terminalBar(50), '██████████░░░░░░░░░░');
});

test('short clips and tails report their remaining duration but wait for completion', () => {
    const item = {kind: 'http', duration: 53, preparation: {stage: 'buffering'},
        media: {baseTime: 50, bufferedUntil: 53, complete: false}};
    const rows = startupRows(item, null, true);
    assert.equal(rows.find(row => row.id === 'buffer').detail, '3.0 / 3.0 s');
    assert.equal(rows.find(row => row.id === 'playback').state, 'wait');
    item.media.complete = true;
    assert.equal(startupRows(item, null, true).find(row => row.id === 'buffer').state, 'ok');
    assert.equal(startupRows(item, null, true).find(row => row.id === 'playback').state, 'busy');
});

test('failures and disconnections halt active work; unrelated submissions cannot poison the current item', () => {
    const item = {status: 'error', error: 'Source failed', preparation: {stage: 'transcoding', seconds: 0}};
    const failed = startupRows(item, null, true);
    assert.equal(failed.at(-1).state, 'fail');
    assert.equal(failed.some(row => row.state === 'busy'), false);
    const disconnected = startupRows({...item, status: 'processing', error: null}, null, false);
    assert.equal(disconnected.some(row => row.state === 'busy'), false);
    const current = startupRows({...item, status: 'processing', error: null}, {error: 'Another video failed'}, true);
    assert.equal(current.some(row => row.state === 'fail'), false);
});
