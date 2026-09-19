import {ballArena, BALL_WIDTH, BALL_HEIGHT} from '../../shared/beach-ball.js';
import {fingerPivot, startPointerTicker} from '../../shared/reaction-pointer.js';

export function trackReactionPointer(node, initial) {
    let options = initial;
    let point = null;
    let entry = null;
    let sent = false;
    let sentTaps = 0;
    let pointerId = null;
    let tapTime = null;
    const showFinger = finger => options.onFinger(finger ? {...finger, tapTime} : null);
    const listen = (target, name, fn) => {
        target.addEventListener(name, fn);
        return () => target.removeEventListener(name, fn);
    };
    function publish() {
        if (!options.connected || !point || document.hidden) return;
        options.onCommand({type: 'reaction:pointer', ...point});
        sent = true;
        sentTaps = point.finger?.taps || 0;
    }
    function clear(resetEntry = true, notify = true) {
        // Preserve a quick down/up/leave that occurred between network ticks.
        if (notify && point?.finger?.taps > sentTaps) publish();
        if (notify && sent && options.connected) options.onCommand({type: 'reaction:pointer', x: null, y: null});
        point = null;
        sent = false;
        sentTaps = 0;
        pointerId = null;
        tapTime = null;
        if (resetEntry) entry = null;
        showFinger(null);
    }
    function coordinates(event) {
        const rect = node.getBoundingClientRect();
        return {rect, x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height};
    }
    function enter(event) {
        if (event.isPrimary === false) return;
        const {rect, x, y} = coordinates(event);
        entry = fingerPivot(Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y)), rect.width, rect.height);
        move(event);
    }
    function move(event) {
        if (event.isPrimary === false || (pointerId !== null && event.pointerId !== pointerId)) return;
        if (!options.connected || !options.enabled || document.hidden
            || event.target.closest('.player-controls, .whiteboard-tools, button:not(.hitmarker-target), input, a, select, textarea')) return clear(false);
        const {rect, x, y} = coordinates(event);
        if (x < 0 || x > 1 || y < 0 || y > 1 || !rect.width || !rect.height) return clear();
        entry ||= fingerPivot(x, y, rect.width, rect.height);
        const previous = point?.finger;
        const finger = options.fingerEnabled ? {x, y, pivot: entry, pressed: previous?.pressed || false, taps: previous?.taps || 0} : null;
        const inset = parseFloat(getComputedStyle(node).getPropertyValue('--controls-height')) || 71;
        const arena = ballArena(rect.width, rect.height, inset);
        const bx = (event.clientX - rect.left - arena.x) / (BALL_WIDTH * arena.scale);
        const by = (event.clientY - rect.top - arena.y) / (BALL_HEIGHT * arena.scale);
        const ball = options.beachBall && bx >= 0 && bx <= 1 && by >= 0 && by <= 1;
        if (!finger && !ball) return clear(false);
        point = {x: ball ? bx : null, y: ball ? by : null, finger};
        showFinger(finger);
    }
    function down(event) {
        if (event.button !== 0 || event.isPrimary === false) return;
        move(event);
        if (!point?.finger) return;
        event.preventDefault();
        pointerId = event.pointerId;
        tapTime = performance.now();
        point.finger = {...point.finger, pressed: true, taps: point.finger.taps + 1};
        showFinger(point.finger);
        options.onTap();
    }
    function release(event) {
        if (pointerId !== null && event.pointerId !== pointerId) return;
        pointerId = null;
        if (point?.finger) {
            point.finger = {...point.finger, pressed: false};
            showFinger(point.finger);
        }
        if (event.pointerType !== 'mouse') clear();
    }
    const leave = () => clear();
    const hidden = () => { if (document.hidden) clear(); };
    const remove = [listen(node, 'pointerenter', enter), listen(node, 'pointermove', move),
        listen(node, 'pointerdown', down), listen(node, 'pointerleave', leave), listen(node, 'pointercancel', leave),
        listen(window, 'pointerup', release), listen(window, 'blur', leave), listen(document, 'visibilitychange', hidden)];
    // Sample the latest cursor once per tick, including while stationary. Never burst after a stalled tab.
    const stopTick = startPointerTicker(publish);
    return {
        update(next) {
            if (next.roomId !== options.roomId || next.connected !== options.connected) clear(true, false);
            else if ((!next.enabled && options.enabled) || next.fingerEnabled !== options.fingerEnabled
                || (!next.beachBall && options.beachBall)) clear(false);
            options = next;
        },
        destroy() { clear(); stopTick(); for (const off of remove) off(); },
    };
}
