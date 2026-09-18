import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopLayout} from '../src/lib/desktop-layout.js';

test('desktop tiling fits landscape, portrait and incomplete rows within the available space', () => {
    assert.deepEqual(desktopLayout(1, 960, 540), {columns: 1, rows: 1});
    assert.deepEqual(desktopLayout(2, 960, 430), {columns: 2, rows: 1});
    assert.deepEqual(desktopLayout(2, 390, 700), {columns: 1, rows: 2});
    assert.deepEqual(desktopLayout(3, 960, 430), {columns: 2, rows: 2});
    assert.deepEqual(desktopLayout(4, 960, 430), {columns: 2, rows: 2});
    for (const count of [1, 2, 3, 4, 5, 8, 12, 25]) {
        const {columns, rows} = desktopLayout(count, 960, 430);
        assert.ok(columns * rows >= count);
        assert.ok(columns * (rows - 1) < count);
    }
});
