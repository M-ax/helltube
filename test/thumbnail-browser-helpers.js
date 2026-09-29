import assert from 'node:assert/strict';
import {until} from './helpers.js';

export async function checkThumbnailInteractions(page, otherViewer, room, instance) {
    const nativeVideo = page.locator('.video-viewport > video');
    const stream = page.locator('.desktop-tile');
    const streamVideo = stream.locator('video');
    const videoTile = page.locator('.video-thumbnail-controls');
    const initialPlayback = {...room.playback};
    await streamVideo.evaluate(video => { window.thumbnailStream = {video, stream: video.srcObject, volume: video.volume, muted: video.muted}; });
    const opacityOf = tile => tile.evaluate(node => Number(getComputedStyle(node).opacity));
    const controlOpacity = () => stream.locator('.desktop-controls').evaluate(node => getComputedStyle(node).opacity);
    const drag = async (handle, dx, dy) => {
        const bounds = await handle.boundingBox();
        const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + dx, y + dy, {steps: 8});
        await page.mouse.up();
    };
    const inBounds = async tile => {
        await until(() => tile.evaluate(node => {
            const rect = node.getBoundingClientRect(), grid = document.querySelector('.desktop-grid').getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.left >= grid.left - 1 && rect.right <= grid.right + 1 &&
                rect.top >= grid.top - 1 && rect.bottom <= grid.bottom + 1;
        })).catch(async error => {
            throw new Error(`Thumbnail must stay inside the player: ${JSON.stringify(await tile.evaluate(node => ({
                tile: node.getBoundingClientRect().toJSON(), grid: document.querySelector('.desktop-grid').getBoundingClientRect().toJSON(),
            })))}`, {cause: error});
        });
    };
    const retained = async () => {
        assert.equal(await nativeVideo.evaluate(video => video === window.retainedVideo.video &&
            video.currentSrc === window.retainedVideo.src && !video.paused && video.currentTime >= window.retainedVideo.time), true,
        'Thumbnail interactions retain the video decoder, source and playback position');
        assert.equal(await streamVideo.evaluate(video => video === window.thumbnailStream.video &&
            video.srcObject === window.thumbnailStream.stream && !video.paused &&
            video.volume === window.thumbnailStream.volume && video.muted === window.thumbnailStream.muted), true,
        'Thumbnail interactions retain the live stream and its audio preferences');
        assert.deepEqual(room.playback, initialPlayback, 'Thumbnail focus and gestures are local, without room playback commands');
    };

    await page.mouse.move(0, 0);
    assert.equal(await controlOpacity(), '0', 'Thumbnail volume is hidden off hover');
    await stream.hover();
    assert.equal(await controlOpacity(), '1', 'Thumbnail volume appears on hover');
    assert.equal(await stream.evaluate(node => {
        const border = getComputedStyle(node, '::after');
        const focus = getComputedStyle(node.querySelector('.desktop-focus'));
        return border.top === '0px' && border.bottom === '0px' && border.left === '0px' && border.right === '0px' &&
            border.borderTopWidth === '1px' && focus.borderTopWidth === '0px';
    }), true, 'The thumbnail border encloses the full tile, including volume controls');
    const volume = stream.getByRole('slider', {name: /^Volume for /});
    await volume.hover();
    const scroll = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 100);
    await until(() => volume.inputValue().then(value => value === '0.95'));
    assert.equal(await page.evaluate(() => scrollY), scroll, 'Stream thumbnail volume wheel locks page scrolling');
    await page.mouse.wheel(0, -100);
    await until(() => volume.inputValue().then(value => value === '1'));
    // Volume changes explicitly unmute, so restore this viewer's initial choice.
    await streamVideo.evaluate(video => { video.muted = window.thumbnailStream.muted; });
    await until(() => streamVideo.evaluate(video => video.volume === window.thumbnailStream.volume));

    for (const kind of ['stream', 'video']) {
        if (kind === 'video') {
            await stream.locator('.desktop-focus').click();
            await until(() => nativeVideo.evaluate(video => video.classList.contains('floating-thumbnail')));
            assert.equal(await otherViewer.locator('.desktop-tile.thumbnail').count(), 1, 'Focus does not change another viewer');
        }
        const tile = kind === 'stream' ? stream : videoTile;
        const picture = kind === 'stream' ? stream : nativeVideo;
        const surface = tile.locator('[data-thumbnail-drag]');
        const opacity = tile.getByRole('slider', {name: /^Opacity for /});
        const resize = tile.getByRole('button', {name: /^Resize thumbnail for /});
        const toolStyles = () => tile.locator('.thumbnail-tools, .thumbnail-resize').evaluateAll(nodes =>
            nodes.map(node => ({opacity: getComputedStyle(node).opacity, pointerEvents: getComputedStyle(node).pointerEvents})));
        await page.mouse.move(0, 0);
        assert.deepEqual(await toolStyles(), Array(2).fill({opacity: '0', pointerEvents: 'none'}), `${kind} controls hide off hover`);
        await surface.hover();
        assert.deepEqual(await toolStyles(), Array(2).fill({opacity: '1', pointerEvents: 'auto'}), `${kind} controls appear on thumbnail hover`);
        assert.equal(await resize.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', 'Resize handle has no filled background');
        await resize.click();
        await page.mouse.move(0, 0);
        assert.deepEqual(await toolStyles(), Array(2).fill({opacity: '0', pointerEvents: 'none'}), 'Mouse focus does not keep controls visible after leaving');
        await page.keyboard.press('Tab');
        await opacity.focus();
        assert.deepEqual(await toolStyles(), Array(2).fill({opacity: '1', pointerEvents: 'auto'}), 'Keyboard users can reveal thumbnail controls');
        await inBounds(tile);
        if (kind === 'video') {
            const grid = await page.locator('.desktop-grid').boundingBox();
            const checkClear = () => stream.locator('.desktop-controls').evaluate(control => {
                const rect = control.getBoundingClientRect();
                const thumb = document.querySelector('.video-thumbnail-controls').getBoundingClientRect();
                const tile = control.closest('.desktop-tile').getBoundingClientRect();
                return rect.left >= tile.left && rect.right <= tile.right && rect.top >= tile.top && rect.bottom <= tile.bottom &&
                    (rect.right <= thumb.left || rect.left >= thumb.right || rect.bottom <= thumb.top || rect.top >= thumb.bottom);
            });
            for (const [x, y] of [[0, 1], [0, 0.5], [1, 1], [1, 0], [0.5, 1]]) {
                const current = await tile.boundingBox();
                await drag(surface, grid.x + x * (grid.width - current.width) - current.x,
                    grid.y + y * (grid.height - current.height) - current.y);
                await until(checkClear);
            }
        }
        const before = await tile.boundingBox();
        await drag(surface, -85, -65);
        const moved = await tile.boundingBox();
        assert.ok(moved.x < before.x - 70 && moved.y < before.y - 50, `${kind} thumbnail drags: ${JSON.stringify({before, moved})}`);
        assert.equal(await stream.evaluate(node => node.classList.contains('thumbnail')), kind === 'stream', 'Dragging never promotes the thumbnail');
        await drag(resize, 65, 20);
        const resized = await tile.boundingBox();
        assert.ok(resized.width > moved.width + 50, `${kind} thumbnail resizes`);
        assert.ok(Math.abs(resized.width / resized.height - 16 / 9) < 0.02);
        await resize.focus();
        await resize.press('ArrowLeft');
        assert.ok((await tile.boundingBox()).width < resized.width - 5, 'Keyboard resizing is available');
        await surface.evaluate(node => node.addEventListener('pointerdown', event => window.thumbnailPointerId = event.pointerId, {once: true}));
        const handle = await surface.boundingBox();
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2 + 20, handle.y + handle.height / 2 - 15, {steps: 3});
        await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', {pointerId: window.thumbnailPointerId})));
        const cancelled = await tile.boundingBox();
        await page.mouse.move(handle.x + handle.width / 2 + 45, handle.y + handle.height / 2 - 30, {steps: 3});
        await page.mouse.up();
        assert.deepEqual(await tile.boundingBox(), cancelled, 'Cancelled gestures stop moving the thumbnail');
        assert.equal(await tile.evaluate(node => node.classList.contains('thumbnail-dragging')), false);
        await inBounds(tile);
        await opacity.hover();
        const scrollBefore = await page.evaluate(() => scrollY);
        await page.mouse.wheel(0, 100);
        await until(() => opacity.getAttribute('aria-valuenow').then(value => value === '75'));
        assert.equal(await opacityOf(picture), 0.75, `${kind} opacity changes the actual picture`);
        assert.equal(await page.evaluate(() => scrollY), scrollBefore, 'Opacity wheel locks page scrolling');
        assert.equal(await volume.inputValue(), '1', 'Opacity scrolling leaves volume unchanged');
        await opacity.focus();
        await opacity.press('Home');
        await page.mouse.wheel(0, 100);
        assert.equal(await opacity.getAttribute('aria-valuenow'), '10', 'Opacity has a visible minimum');
        await opacity.press('End');
        await page.mouse.wheel(0, -100);
        assert.equal(await opacity.getAttribute('aria-valuenow'), '100', 'Opacity cannot exceed 100%');
        await opacity.press('ArrowDown');
        assert.equal(await opacity.getAttribute('aria-valuenow'), '95');
        await page.mouse.move(0, 0);
        assert.equal(await opacityOf(picture), 0.95, 'Opacity remains set off hover');
        await retained();
        const saved = await tile.boundingBox();
        if (kind === 'stream') {
            await surface.click();
            await until(() => nativeVideo.evaluate(video => video.classList.contains('floating-thumbnail')));
            await page.mouse.move(0, 0);
            assert.equal(await controlOpacity(), '0', 'Focused stream volume hides off hover');
            await stream.hover();
            assert.equal(await controlOpacity(), '1', 'Focused stream volume appears on hover');
            await videoTile.locator('[data-thumbnail-drag]').click();
        } else {
            await surface.click();
            assert.equal(await nativeVideo.evaluate(video => video.classList.contains('floating-thumbnail')), false);
            assert.equal(await opacityOf(nativeVideo), 1, 'Returning to the main player restores full opacity');
            await stream.locator('.desktop-focus').click();
        }
        await until(async () => Math.abs((await tile.boundingBox()).width - saved.width) < 1).catch(async error => {
            throw new Error(`${kind} placement restore: ${JSON.stringify({saved, current: await tile.boundingBox(),
                focus: await stream.getAttribute('class'), style: await tile.getAttribute('style')})}`, {cause: error});
        });
        const restored = await tile.boundingBox();
        assert.ok(Math.abs(restored.x - saved.x) < 1 && Math.abs(restored.y - saved.y) < 1, 'Placement survives focus swaps');
        assert.equal(await opacityOf(picture), 0.95, 'Opacity survives focus swaps');
        await retained();
    }

    // Room pause/seek/play still addresses the same media element while it is a thumbnail.
    instance.rooms.control(room, {action: 'pause', revision: room.playback.revision});
    await until(() => nativeVideo.evaluate(video => video.paused));
    assert.equal(await streamVideo.evaluate(video => video.paused), false);
    instance.rooms.control(room, {action: 'seek', position: 20, revision: room.playback.revision});
    await until(() => nativeVideo.evaluate(video => Math.abs(video.currentTime - 20) < 0.75));
    instance.rooms.control(room, {action: 'play', revision: room.playback.revision});
    await until(() => nativeVideo.evaluate(video => !video.paused));
    assert.equal(await nativeVideo.evaluate(video => video === window.retainedVideo.video), true);
    await page.setViewportSize({width: 390, height: 844});
    await inBounds(videoTile);
    await page.getByRole('button', {name: 'Toggle fullscreen'}).click();
    await until(() => page.evaluate(() => !!document.fullscreenElement));
    await inBounds(videoTile);
    await page.evaluate(() => document.exitFullscreen());
    await page.setViewportSize({width: 1280, height: 720});
    await inBounds(videoTile);
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur());
    await until(() => page.locator('.player-shell').getAttribute('data-controls-visible').then(value => value === 'false'));
    await videoTile.locator('[data-thumbnail-drag]').click();
    assert.equal(await nativeVideo.evaluate(video => video.classList.contains('floating-thumbnail')), false,
        'One click restores the video even after transport controls auto-hide');
    await stream.locator('.desktop-focus').click();
    // The caller stops this focused stream and verifies that the video restores automatically.
}
