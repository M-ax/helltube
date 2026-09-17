import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, rm, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import path from 'node:path';
import {createApp} from '../server/app.js';
import {createWorker} from '../worker.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const enabled = process.platform === 'linux' && process.getuid?.() === 0 && process.env.HELLTUBE_SYSTEMD_TEST === '1';
const systemctl = (...args) => exec('systemctl', args, {timeout: 15000});
const stamp = file => stat(file, {bigint: true}).then(value => value.mtimeNs, error => {
    if (error.code === 'ENOENT') return null;
    throw error;
});

test('fresh bootstrap Worker callbacks wake real systemd paths on creation and atomic replacement', {
    skip: !enabled && 'Needs root, systemd and HELLTUBE_SYSTEMD_TEST=1; uses isolated runtime units only.', timeout: 90000,
}, async t => {
    const directory = await mkdtemp('/run/helltube-callback-');
    const unit = path.basename(directory);
    const files = ['service', 'timer', 'path'].map(extension => `/run/systemd/system/${unit}.${extension}`);
    let instance;
    t.after(async () => {
        try {
            await systemctl('--runtime', 'disable', '--now', `${unit}.timer`, `${unit}.path`);
            await systemctl('stop', `${unit}.service`);
        } finally {
            await instance?.close();
            await Promise.all(files.map(file => rm(file, {force: true})));
            await systemctl('daemon-reload');
            await rm(directory, {recursive: true, force: true});
        }
    });
    await mkdir(path.join(directory, 'work'));
    const dataDir = path.join(directory, 'data');
    const notification = path.join(dataDir, 'worker-deployment.json');
    const triggered = path.join(directory, 'triggered');
    const secret = randomBytes(32).toString('hex');
    const current = 'a'.repeat(40);
    instance = await createApp({dataDir, host: '127.0.0.1', port: 0, backendCommit: current, edgeProxySecret: secret,
        maxTranscoders: 0, ffmpeg: '/nonexistent-fixture-ffmpeg', ytdlp: '/nonexistent-fixture-ytdlp'});
    const origin = await instance.listen(0);
    const install = choice => exec('bash', [path.join(root, 'test/fixtures/deployment-callback-units.sh'),
        root, directory, unit, choice], {timeout: 15000});
    async function callback(commit, edgeSecret = secret) {
        // A new Worker instance ensures backend deduplication is also exercised.
        const worker = createWorker();
        const version = {buildId: 'callback-test-build', commit};
        return worker.fetch(new Request(`https://watch.example.test/__deployment?buildId=${version.buildId}`, {method: 'POST'}), {
            BARE_METAL_ORIGIN: origin, EDGE_PROXY_SECRET: edgeSecret,
            ASSETS: {fetch: async () => Response.json(version)},
        });
    }
    async function waitForTrigger(previous) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const value = await stamp(triggered);
            if (value !== null && value !== previous) {
                await sleep(300);
                assert.equal((await systemctl('show', `${unit}.path`, '-p', 'SubState', '--value')).stdout.trim(), 'waiting');
                return stamp(triggered);
            }
            await sleep(50);
        }
        assert.fail('A Worker announcement did not trigger the installed systemd path.');
    }

    assert.equal(await stamp(notification), null, 'Fresh installs have no announcement file.');
    await install('yes');
    for (const suffix of ['timer', 'path']) {
        await systemctl('is-active', '--quiet', `${unit}.${suffix}`);
        await systemctl('is-enabled', '--quiet', `${unit}.${suffix}`);
    }
    assert.equal((await callback('b'.repeat(40), 'invalid-secret')).status, 502);
    assert.equal((await callback(current)).status, 200);
    assert.equal(await stamp(notification), null);
    assert.equal(await stamp(triggered), null, 'Neither unauthorized nor matching callbacks trigger updates.');

    assert.equal((await callback('b'.repeat(40))).status, 200);
    let previous = await waitForTrigger(null);
    assert.equal(JSON.parse(await readFile(notification, 'utf8')).commit, 'b'.repeat(40));
    assert.equal((await callback('b'.repeat(40))).status, 200);
    await sleep(500);
    assert.equal(await stamp(triggered), previous, 'Duplicate callbacks do not retrigger the updater.');

    assert.equal((await callback('c'.repeat(40))).status, 200);
    previous = await waitForTrigger(previous);
    t.diagnostic('Worker -> authenticated backend -> new/atomically replaced file -> real systemd service passed.');

    await install('no');
    for (const suffix of ['timer', 'path']) {
        await assert.rejects(systemctl('is-active', '--quiet', `${unit}.${suffix}`));
        await assert.rejects(systemctl('is-enabled', '--quiet', `${unit}.${suffix}`));
    }
    assert.equal((await callback('d'.repeat(40))).status, 200);
    await sleep(500);
    assert.equal(await stamp(triggered), previous, 'Disabled automatic updates remain disabled.');

    await install('yes');
    assert.equal((await callback('e'.repeat(40))).status, 200);
    await waitForTrigger(previous);
    assert.equal((await (await fetch(`${origin}/api/version`)).json()).commit, current);
    t.diagnostic('Disabled and re-enabled bootstrap settings passed; production units and data were never used.');
});
