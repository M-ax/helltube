import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';

test('built OBS Helltube service encodes and streams native H264/Opus to a browser', {timeout: 60000}, async t => {
    const h = await start(t, {ffmpeg: 'missing-server-ffmpeg', ytdlp: 'missing-test-ytdlp'});
    const fixture = path.join(h.dir, 'obs-pattern.mp4');
    await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fixture], {windowsHide: true});
    const ws = await h.connect(); ws.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    await until(() => h.instance.rooms.get('lobby').members.size);
    const {data} = await h.api('/api/rooms/lobby/obs-token', {method: 'POST'});
    const directory = path.resolve('apps/obs-studio/build_x64/rundir/RelWithDebInfo/bin/64bit');
    const helper = spawn(path.join(directory, 'helltube-obs-check.exe'), [], {cwd: directory, windowsHide: true});
    let log = '';
    helper.stdout.on('data', bytes => log += bytes);
    helper.stderr.on('data', bytes => log += bytes);
    const done = new Promise((resolve, reject) => { helper.once('error', reject); helper.once('close', resolve); });
    t.after(async () => { if (helper.exitCode === null) helper.kill(); await done; await writeFile('test-artifacts/obs-native.log', log); });
    helper.stdin.write(JSON.stringify({server: h.url + data.path, bearer_token: data.token, fixture}) + '\n');
    await until(() => {
        if (helper.exitCode !== null) throw new Error(`OBS helper exited ${helper.exitCode}; see test-artifacts/obs-native.log`);
        return log.includes('HELLTUBE_OBS_READY');
    }, 30000);
    const session = [...h.instance.desktop.sessions.values()][0];
    assert.equal(session.ready, true);
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(h.url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
    const video = page.locator('.desktop-tile video');
    await until(() => video.evaluateAll(videos => videos.length === 1 && videos[0].videoWidth === 640 && videos[0].readyState >= 2), 20000);
    const pixel = await video.evaluate(video => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
    });
    assert.ok(pixel[0] > 180 && pixel[1] < 50 && pixel[2] < 50, JSON.stringify(pixel));
    for (const producer of session.producers.values()) {
        const stats = await producer.getStats();
        assert.ok(stats.some(stat => stat.byteCount > 1000), `${producer.kind} must carry media`);
    }
    helper.stdin.write('stop\n');
    assert.equal(await done, 0);
    assert.doesNotMatch(log, /DELETE request for resource URL failed/);
    await until(() => h.instance.desktop.sessions.size === 0);
    assert.equal(session.router.closed, true);
});
