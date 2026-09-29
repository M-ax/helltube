import test from 'node:test';
import assert from 'node:assert/strict';
import {thumbnailRect, moveThumbnail, controlsPosition} from '../src/lib/thumbnail.js';

test('stream controls avoid thumbnails at every position and return when clear', () => {
    const width = 960, height = 430, controlWidth = 200, controlHeight = 36;
    assert.deepEqual(controlsPosition(width, height, controlWidth, controlHeight, []), {left: 8, bottom: 8});
    for (let x = 0; x <= 720; x += 120) for (let y = 0; y <= 300; y += 50) {
        const obstacles = [{x, y, width: 240, height: 130}, {x: 220, y: 180, width: 200, height: 120}];
        const position = controlsPosition(width, height, controlWidth, controlHeight, obstacles);
        const top = height - position.bottom - controlHeight;
        assert.ok(position.left >= 8 && position.left + controlWidth <= width - 8);
        assert.ok(top >= 8 && top + controlHeight <= height - 8);
        for (const rect of obstacles) assert.ok(position.left + controlWidth <= rect.x - 8 ||
            position.left >= rect.x + rect.width + 8 || top + controlHeight <= rect.y - 8 || top >= rect.y + rect.height + 8);
    }
});

test('controls remain bounded when a thumbnail covers the whole stream', () => {
    assert.deepEqual(controlsPosition(200, 100, 184, 36, [{x: 0, y: 0, width: 200, height: 100}]), {left: 8, bottom: 8});
});

function inside(rect, width, height) {
    assert.ok(rect.x >= 0 && rect.y >= 0);
    assert.ok(rect.x + rect.width <= width + 0.001);
    assert.ok(rect.y + rect.height <= height + 0.001);
    assert.ok(Math.abs(rect.width / (16 / 9) - rect.height) < 0.001);
}

for (const [width, height] of [[960, 430], [374, 210], [200, 80], [32, 18], [0, 0]]) {
    test(`default video/stream thumbnail rows fit ${width} x ${height}`, () => {
        for (const count of [1, 2, 3, 8, 25]) {
            let previous;
            for (let index = 0; index < count; index++) {
                const rect = thumbnailRect(width, height, index, count);
                inside(rect, width, height);
                if (previous) assert.ok(previous.x + previous.width <= rect.x + 0.001);
                previous = rect;
            }
        }
    });
}

for (const resize of [false, true]) {
    test(`${resize ? 'resizing' : 'dragging'} clamps every edge and preserves aspect ratio`, () => {
        const rect = thumbnailRect(960, 430);
        for (const dx of [-10000, -100, 0, 50, 10000]) {
            for (const dy of [-10000, -100, 0, 50, 10000]) {
                const placement = moveThumbnail(rect, dx, dy, 960, 430, resize);
                const moved = thumbnailRect(960, 430, 0, 1, placement);
                inside(moved, 960, 430);
                assert.ok(moved.width >= 120);
                if (!resize) assert.equal(moved.width, rect.width);
            }
        }
    });
}

test('the resize handle can enlarge a thumbnail from its default bottom position', () => {
    const rect = thumbnailRect(960, 430);
    const resized = thumbnailRect(960, 430, 0, 1, moveThumbnail(rect, 60, 20, 960, 430, true));
    assert.ok(resized.width > rect.width);
    inside(resized, 960, 430);
});

test('user size and placement survive thumbnail reorder, fullscreen and narrow viewports', () => {
    const rect = thumbnailRect(960, 430);
    const placement = moveThumbnail(rect, -200, -180, 960, 430);
    assert.deepEqual(thumbnailRect(960, 430, 0, 1, placement), thumbnailRect(960, 430, 3, 5, placement));
    for (const [width, height] of [[1920, 1080], [374, 190], [80, 40], [0, 0], [960, 430]]) {
        inside(thumbnailRect(width, height, 0, 1, placement), width, height);
    }
});
