import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';

test('room dropbox shares selected and dropped files, downloads, resumes and removes across browsers', {timeout: 60000}, async t => {
    const {instance, url} = await start(t, {maxTranscoders: 0});
    await instance.accounts.create({username: 'viewer', displayName: 'Viewer', password: 'viewer-password', role: 'user'});
    instance.rooms.create('Other room');
    const browser = await chromium.launch({channel: 'chrome', headless: true});
    t.after(() => browser.close());
    const a = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const b = await browser.newPage({viewport: {width: 390, height: 844}});
    const errors = [];
    for (const [page, username, password] of [[a, 'admin', 'garbageTime_'], [b, 'viewer', 'viewer-password']]) {
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url);
        await page.getByLabel('Username', {exact: true}).fill(username);
        await page.getByLabel('Password', {exact: true}).fill(password);
        await page.getByRole('button', {name: 'Enter Helltube'}).click();
        if (page === b) await page.getByRole('button', {name: 'Open room navigation'}).click();
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
        await page.getByRole('region', {name: 'Shared files'}).getByText('No shared files yet. Add the first one.').waitFor();
    }
    await a.getByLabel('Choose shared files', {exact: true}).setInputFiles([
        {name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('shared notes')},
        {name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0)},
    ]);
    const panel = page => page.getByRole('region', {name: 'Shared files'});
    await panel(b).getByRole('button', {name: 'Download notes.txt', exact: true}).waitFor();
    await panel(b).getByRole('button', {name: 'Download empty.bin', exact: true}).waitFor();
    assert.equal(await panel(b).getByRole('button', {name: 'Remove shared file notes.txt', exact: true}).count(), 0);
    const downloadEvent = b.waitForEvent('download');
    await panel(b).getByRole('button', {name: 'Download notes.txt', exact: true}).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'notes.txt');
    assert.equal(await readFile(await download.path(), 'utf8'), 'shared notes');
    const longName = 'a'.repeat(160) + '.txt';
    const dragResult = await panel(b).getByRole('button', {name: /Drop files here/}).evaluate((node, name) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(['dropped'], name, {type: 'text/plain'}));
        let reachedWindow = false;
        const atWindow = () => { reachedWindow = true; };
        window.addEventListener('dragover', atWindow);
        const dragEvent = new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer});
        node.dispatchEvent(dragEvent);
        window.removeEventListener('dragover', atWindow);
        node.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer}));
        return {prevented: dragEvent.defaultPrevented, reachedWindow};
    }, longName);
    assert.deepEqual(dragResult, {prevented: true, reachedWindow: false}, 'Shared-file drags are handled before reaching the video composer.');
    await panel(a).getByRole('button', {name: 'Download ' + longName, exact: true}).waitFor();
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await b.reload();
    await panel(b).getByRole('button', {name: 'Download notes.txt', exact: true}).waitFor();
    const original = {name: 'resume.txt', size: 5, lastModified: 123};
    await a.evaluate(async metadata => {
        const registration = await fetch('/api/rooms/lobby/files', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(metadata)});
        const {file} = await registration.json();
        await fetch('/api/files/' + file.id + '?offset=0', {method: 'PUT', headers: {'Content-Type': 'application/octet-stream'}, body: 'he'});
    }, original);
    await panel(a).getByRole('button', {name: 'Resume sharing resume.txt'}).waitFor();
    const chooserEvent = a.waitForEvent('filechooser');
    await panel(a).getByRole('button', {name: 'Resume sharing resume.txt'}).click();
    await chooserEvent;
    await a.getByLabel('Reselect shared file', {exact: true}).evaluate(node => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['hello'], 'resume.txt', {lastModified: 123}));
        node.files = transfer.files;
        node.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await panel(b).getByRole('button', {name: 'Download resume.txt', exact: true}).waitFor();
    await panel(a).getByRole('button', {name: 'Remove shared file notes.txt', exact: true}).click();
    await panel(a).getByRole('group', {name: 'Confirm removal of notes.txt'}).getByRole('button', {name: 'Remove', exact: true}).click();
    await until(async () => await panel(b).getByRole('button', {name: 'Download notes.txt', exact: true}).count() === 0);
    await a.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^Other room(?: |$)/}).click();
    await panel(a).getByText('No shared files yet. Add the first one.').waitFor();
    assert.equal(instance.rooms.get('lobby').current, null);
    assert.deepEqual(errors, []);
});
