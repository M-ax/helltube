import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {NativeVideo} from '../apps/caster/main/video.js';

const helper = path.resolve('apps/caster/native/bin/helltube-video.exe');
test('native GPU crop, scale, rotation and cached frames preserve expected pixels', {skip: process.platform !== 'win32'}, async () => {
    const {stdout} = await promisify(execFile)(path.resolve('apps/caster/native/build/Release/helltube-video-test.exe'), [],
        {windowsHide: true, timeout: 20000});
    assert.match(stdout, /passed/);
});
test('actual DXGI captures each attached monitor, honors backpressure, and exits on parent EOF', {
    skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
    const frames = [], events = [];
    const video = new NativeVideo({helper, emit: event => { events.push(event); if (event.type === 'video-frame') frames.push(event); }});
    t.after(() => video.stop());
    const sources = await video.list('screen');
    assert.ok(sources.length, 'An interactive Windows desktop is required');
    for (const source of sources) {
        frames.length = 0;
        const id = randomUUID();
        const result = await video.start({sourceId: source.id, sessionId: id,
            quality: {width: 640, height: 360, frameRate: 15}, showCursor: false});
        assert.equal(result.backend, 'Native DXGI');
        assert.ok(frames[0].width <= 640 && frames[0].height <= 360);
        assert.equal(frames[0].pixels.length, frames[0].width * frames[0].height * 4);
        await delay(200);
        assert.equal(frames.length, 1, 'The helper waits for the renderer instead of queueing frames');
        video.acknowledge(id, frames[0].sequence);
        const deadline = Date.now() + 3000;
        while (frames.length < 2 && Date.now() < deadline) await delay(20);
        assert.equal(frames.length, 2, 'Static monitors still deliver frames for late viewers');
        const child = video.capture.child;
        const exited = new Promise(resolve => child.once('exit', resolve));
        // End only the stdin pipe; prove the native helper can clean up even
        // without Electron explicitly killing it.
        child.stdin.end();
        assert.equal(await Promise.race([exited.then(() => true), delay(3000).then(() => false)]), true, 'Parent EOF releases DXGI capture');
        assert.equal(video.capture, null);
    }
});
