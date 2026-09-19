export const WHITEBOARD_TOOLS = ['pen', 'line', 'arrow', 'rectangle', 'ellipse'];
export const WHITEBOARD_COLORS = ['#ffffff', '#ff975e', '#ff657a', '#ffd866', '#80d9a4', '#73c7ff', '#c4a1ff'];
export const WHITEBOARD_WIDTHS = [2, 4, 8];
export const WHITEBOARD_BATCH = 32;
export const WHITEBOARD_MAX_POINTS = 1024;
export const WHITEBOARD_MAX_SHAPES = 200;
export const WHITEBOARD_ROOM_POINTS = 16384;
export const WHITEBOARD_INTERVAL = 40;

export function validWhiteboardPoint(point) {
    return Array.isArray(point) && point.length === 2
        && point.every(value => Number.isFinite(value) && value >= 0 && value <= 1);
}

export function whiteboardPoint(point) {
    return point.map(value => Math.round(value * 100000) / 100000);
}

export function emptyWhiteboard() {
    return {roomId: null, epoch: null, revision: 0, shapes: [], error: null};
}

// Only structured coordinates reach the SVG renderer; SVG markup is never accepted.
export function reduceWhiteboard(state, message) {
    if (message.type === 'whiteboard:state') return {...message, error: null};
    if (message.type === 'whiteboard:error') return {...state, error: message};
    if (message.epoch !== state.epoch || message.revision <= state.revision) return state;
    const removed = new Set(message.removed || []);
    let shapes = state.shapes.filter(shape => !removed.has(shape.id));
    if (message.action === 'begin') shapes = [...shapes, message.shape];
    if (message.action === 'draw' || message.action === 'end') {
        shapes = shapes.map(shape => shape.id !== message.id ? shape : message.action === 'end'
            ? {...shape, complete: true}
            : {...shape, points: shape.tool === 'pen' ? [...shape.points, ...message.points]
                : [shape.points[0], message.points.at(-1)]});
    }
    return {...state, shapes, revision: message.revision};
}
