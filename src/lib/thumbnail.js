const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const ASPECT = 16 / 9;

// Find the closest clear position to the usual bottom-left controls. If thumbnails
// cover the entire tile, keep the controls in bounds with the least overlap.
export function controlsPosition(width, height, controlWidth, controlHeight, obstacles, gap = 8) {
    const minX = Math.min(gap, Math.max(0, width - controlWidth));
    const minY = Math.min(gap, Math.max(0, height - controlHeight));
    const maxX = Math.max(minX, width - controlWidth - gap);
    const maxY = Math.max(minY, height - controlHeight - gap);
    const xs = [minX, maxX], ys = [maxY, minY];
    for (const rect of obstacles) {
        xs.push(clamp(rect.x - controlWidth - gap, minX, maxX), clamp(rect.x + rect.width + gap, minX, maxX));
        ys.push(clamp(rect.y - controlHeight - gap, minY, maxY), clamp(rect.y + rect.height + gap, minY, maxY));
    }
    let best;
    for (const x of xs) for (const y of ys) {
        const overlap = obstacles.reduce((area, rect) => area +
            Math.max(0, Math.min(x + controlWidth, rect.x + rect.width + gap) - Math.max(x, rect.x - gap)) *
            Math.max(0, Math.min(y + controlHeight, rect.y + rect.height + gap) - Math.max(y, rect.y - gap)), 0);
        const distance = (x - minX) ** 2 + (y - maxY) ** 2;
        if (!best || overlap < best.overlap || (overlap === best.overlap && distance < best.distance)) {
            best = {x, y, overlap, distance};
        }
    }
    return {left: best.x, bottom: Math.max(0, height - best.y - controlHeight)};
}

// Store user placement as fractions so it survives theater/fullscreen and viewport changes.
export function thumbnailRect(width, height, index = 0, count = 1, placement = null) {
    width = Math.max(0, width);
    height = Math.max(0, height);
    count = Math.max(1, count);
    const maxWidth = Math.min(width, height * ASPECT);
    const gap = Math.min(8, width / count);
    const initialWidth = Math.max(0, Math.min(120 * ASPECT, Math.max(72, height / 4) * ASPECT, maxWidth,
        (width - (count - 1) * gap) / count));
    const w = placement?.size == null ? initialWidth : clamp(placement.size * width, Math.min(120, maxWidth), maxWidth);
    const h = Math.min(height, w / ASPECT);
    return {width: w, height: h,
        x: placement?.x == null ? clamp((width - count * (w + gap) + gap) / 2 + index * (w + gap), 0, width - w)
            : clamp(placement.x, 0, 1) * (width - w),
        y: placement?.y == null ? height - h : clamp(placement.y, 0, 1) * (height - h)};
}

export function moveThumbnail(rect, dx, dy, width, height, resize = false) {
    const maxWidth = Math.min(width, height * ASPECT);
    const size = resize ? clamp(rect.width + (Math.abs(dx) >= Math.abs(dy * ASPECT) ? dx : dy * ASPECT),
        Math.min(120, maxWidth), maxWidth) : rect.width;
    const x = clamp(rect.x + (resize ? 0 : dx), 0, width - size);
    const y = clamp(rect.y + (resize ? 0 : dy), 0, height - size / ASPECT);
    return {size: width ? size / width : 0,
        x: width > size ? x / (width - size) : 0,
        y: height > size / ASPECT ? y / (height - size / ASPECT) : 0};
}

// Apply to a stable tile, never move/recreate a media element during a gesture.
export function floatingThumbnail(node, initial) {
    let options = initial, placement = null, gesture = null, rect, bounds;
    let suppressClick = false, observer;
    function render() {
        if (!options.enabled || !bounds) return;
        rect = thumbnailRect(bounds.clientWidth, bounds.clientHeight, options.index, options.count, placement);
        const outer = bounds.getBoundingClientRect();
        // The hidden video controls have no offsetParent during Svelte's update.
        // Their positioned parent is stable even before the thumbnail is shown.
        const parent = node.parentElement.getBoundingClientRect();
        const values = {left: rect.x + outer.left - parent.left, top: rect.y + outer.top - parent.top,
            width: rect.width, height: rect.height};
        const style = Object.entries(values).map(([key, value]) => `--thumbnail-${key}: ${value}px`).join('; ');
        for (const [key, value] of Object.entries(values)) node.style.setProperty(`--thumbnail-${key}`, `${value}px`);
        options.onStyle?.(style);
    }
    function finish(event) {
        if (!gesture || (event?.pointerId != null && event.pointerId !== gesture.id)) return;
        const {target, id, moved} = gesture;
        gesture = null;
        suppressClick = moved;
        if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
        node.classList.remove('thumbnail-dragging');
    }
    function down(event) {
        const target = event.target.closest('[data-thumbnail-drag], [data-thumbnail-resize]');
        if (!options.enabled || event.button !== 0 || !target || gesture || node.closest('[inert]')) return;
        event.stopPropagation();
        suppressClick = false;
        render();
        gesture = {id: event.pointerId, target: node, x: event.clientX, y: event.clientY, rect,
            width: bounds.clientWidth, height: bounds.clientHeight, resize: target.hasAttribute('data-thumbnail-resize'), moved: false};
    }
    function move(event) {
        if (!gesture || event.pointerId !== gesture.id) return;
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
        event.preventDefault();
        if (!gesture.moved) node.setPointerCapture(event.pointerId);
        gesture.moved = true;
        node.classList.add('thumbnail-dragging');
        placement = moveThumbnail(gesture.rect, dx, dy, gesture.width, gesture.height, gesture.resize);
        render();
    }
    function click(event) {
        if (suppressClick && event.detail !== 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
            suppressClick = false;
        }
    }
    function key(event) {
        if (!options.enabled || !event.target.hasAttribute('data-thumbnail-resize')) return;
        const delta = {ArrowRight: 10, ArrowUp: 10, ArrowLeft: -10, ArrowDown: -10}[event.key];
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        render();
        placement = moveThumbnail(rect, delta, 0, bounds.clientWidth, bounds.clientHeight, true);
        render();
    }
    function update(next) {
        if (options.key !== next.key) { finish(); placement = null; }
        if (!next.enabled) finish();
        options = next;
        const nextBounds = options.bounds || node.parentElement;
        if (nextBounds !== bounds) {
            observer?.disconnect();
            bounds = nextBounds;
            observer = new ResizeObserver(render);
            if (bounds) observer.observe(bounds);
        }
        render();
    }
    node.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move, {passive: false});
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    node.addEventListener('lostpointercapture', finish);
    node.addEventListener('click', click, true);
    node.addEventListener('keydown', key);
    window.addEventListener('blur', finish);
    update(initial);
    return {update, destroy() {
        finish(); observer?.disconnect();
        node.removeEventListener('pointerdown', down);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        node.removeEventListener('lostpointercapture', finish);
        node.removeEventListener('click', click, true);
        node.removeEventListener('keydown', key);
        window.removeEventListener('blur', finish);
    }};
}
