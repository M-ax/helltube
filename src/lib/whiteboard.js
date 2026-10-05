// Geometry uses a fixed video coordinate space; the SVG scales it uniformly.
export function whiteboardPath(shape, width, height) {
    const points = shape.points.map(([x, y]) => [x * width, y * height]);
    const [x, y] = points[0];
    const [ex, ey] = points.at(-1);
    if (points.length === 1 || (!['pen', 'spray'].includes(shape.tool) && x === ex && y === ey)) return `M${x} ${y}l0.01 0`;
    if (['pen', 'spray'].includes(shape.tool)) return points.map(([px, py], index) => `${index ? 'L' : 'M'}${px} ${py}`).join(' ');
    if (shape.tool === 'rectangle') return `M${x} ${y}H${ex}V${ey}H${x}Z`;
    if (shape.tool === 'ellipse') {
        const rx = Math.abs(ex - x) / 2, ry = Math.abs(ey - y) / 2;
        const cx = (x + ex) / 2, cy = (y + ey) / 2;
        if (!rx || !ry) return `M${x} ${y}L${ex} ${ey}`;
        return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`;
    }
    const line = `M${x} ${y}L${ex} ${ey}`;
    if (shape.tool !== 'arrow') return line;
    const angle = Math.atan2(ey - y, ex - x);
    const length = Math.min(Math.hypot(ex - x, ey - y) * .4, 12 + shape.width * 2);
    return `${line}M${ex - Math.cos(angle - .5) * length} ${ey - Math.sin(angle - .5) * length}L${ex} ${ey}L${ex - Math.cos(angle + .5) * length} ${ey - Math.sin(angle + .5) * length}`;
}

export function videoBoardBounds(box, videoWidth = 960, videoHeight = 540) {
    const aspect = videoWidth > 0 && videoHeight > 0 ? videoWidth / videoHeight : 16 / 9;
    const width = Math.min(box.width, box.height * aspect);
    const height = width / aspect;
    return {left: (box.width - width) / 2, top: (box.height - height) / 2,
        width, height, drawingWidth: 960, drawingHeight: 960 / aspect};
}

// Follow the actual video element through grid, thumbnail, theater and fullscreen layouts.
export function videoDrawingLayer(node, initial) {
    let options = initial, frame, media, parent;
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(records => {
        if (records.some(record => !record.target.closest?.('.whiteboard-canvas'))) schedule();
    });
    function schedule() { if (!frame) frame = requestAnimationFrame(layout); }
    function layout() {
        frame = null;
        const {viewport, videoId, onLayout} = options;
        if (!viewport) return;
        const nextMedia = [...viewport.querySelectorAll('video[data-whiteboard-video]')]
            .find(video => video.dataset.whiteboardVideo === videoId);
        const nextParent = nextMedia?.parentElement || viewport;
        if (media !== nextMedia || parent !== nextParent) {
            media?.removeEventListener('loadedmetadata', schedule);
            media?.removeEventListener('resize', schedule);
            media = nextMedia; parent = nextParent;
            resize.disconnect(); resize.observe(viewport); resize.observe(parent);
            if (media) { resize.observe(media); media.addEventListener('loadedmetadata', schedule); media.addEventListener('resize', schedule); }
            parent.appendChild(node);
        }
        const rect = (media || viewport).getBoundingClientRect();
        const base = parent.getBoundingClientRect();
        const bounds = videoBoardBounds(rect, media?.videoWidth, media?.videoHeight);
        const style = media && getComputedStyle(media);
        // Coordinates are relative to the parent's padding box (inside its border).
        node.style.left = (rect.left - base.left - parent.clientLeft + bounds.left) + 'px';
        node.style.top = (rect.top - base.top - parent.clientTop + bounds.top) + 'px';
        node.style.width = bounds.width + 'px'; node.style.height = bounds.height + 'px';
        node.style.visibility = style?.visibility || 'visible';
        node.style.opacity = videoId ? style?.opacity || '1' : '1';
        node.style.zIndex = media?.classList.contains('floating-thumbnail') ? '6' : '3';
        onLayout(bounds.drawingWidth, bounds.drawingHeight, viewport.clientWidth, viewport.clientHeight);
    }
    function observe() {
        mutations.disconnect();
        if (options.viewport) mutations.observe(options.viewport, {subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'data-whiteboard-video']});
        schedule();
    }
    observe();
    return {update(next) { options = next; observe(); }, destroy() {
        cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
        media?.removeEventListener('loadedmetadata', schedule); media?.removeEventListener('resize', schedule);
        node.remove();
    }};
}
