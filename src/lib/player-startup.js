import {time, bytes} from './format.js';

export function startupRows(item, pending, connected) {
    const rows = [
        {id: 'display', label: 'CRT display initialized', state: 'ok'},
        {id: 'connection', label: connected ? 'Room link established' : 'Reconnecting to room', state: connected ? 'ok' : 'wait'},
    ];
    if (!item && !pending) {
        rows.push({id: 'idle', label: 'Awaiting video input', state: 'wait'});
        return rows;
    }
    const preparation = item ? item.preparation : pending;
    const stage = preparation?.stage;
    const error = item ? item.error : pending?.error;
    const kind = item?.kind || pending?.kind;
    const metadataDone = !!item && stage !== 'metadata';
    rows.push({id: 'metadata', label: kind === 'upload'
        ? 'Reading file metadata' : 'Fetching source metadata', state: metadataDone ? 'ok' : 'busy'});
    const upload = item?.uploadProgress;
    if (upload) {
        rows.push({id: 'upload', label: upload.complete ? 'File transfer complete' : 'Receiving video upload',
            state: upload.complete ? 'ok' : 'busy', progress: percent(upload.received, upload.total),
            detail: `${bytes(upload.received)} / ${bytes(upload.total)}`});
    }
    const transcoding = ['transcoding', 'buffering', 'ready'].includes(stage) || !!item?.media;
    const complete = !!item?.media?.complete;
    rows.push({id: 'transcode', label: transcoding ? 'FFmpeg transcoding' : 'Waiting for FFmpeg',
        state: complete ? 'ok' : transcoding ? 'busy' : 'wait',
        progress: transcoding ? (complete ? 100 : percent(preparation?.seconds, item?.duration - (preparation?.baseTime || 0))) : undefined,
        detail: transcoding ? `${time(preparation?.seconds || 0)} encoded${preparation?.speed > 0 ? ` · ${preparation.speed.toFixed(1)}x` : ''}` : undefined});
    const buffered = Math.max(0, (item?.media?.bufferedUntil || 0) - (item?.media?.baseTime || 0));
    const target = Math.max(0, Math.min(4, (item?.duration || Infinity) - (item?.media?.baseTime || 0)));
    const bufferReady = complete || buffered >= target;
    rows.push({id: 'buffer', label: 'Building playback buffer', state: bufferReady ? 'ok' : transcoding ? 'busy' : 'wait',
        progress: transcoding ? (bufferReady ? 100 : percent(buffered, target)) : undefined,
        detail: transcoding ? `${Math.min(buffered, target).toFixed(1)} / ${target.toFixed(1)} s` : undefined});
    rows.push({id: 'playback', label: bufferReady ? 'Starting synchronized playback' : 'Standing by for playback',
        state: bufferReady ? 'busy' : 'wait'});
    if (error || item?.status === 'error') {
        for (const row of rows) if (row.state === 'busy') row.state = 'halt';
        rows.push({id: 'error', label: error || 'Video preparation failed', state: 'fail'});
    } else if (!connected) {
        for (const row of rows) if (row.state === 'busy') row.state = 'wait';
    }
    return rows;
}

function percent(value, total) {
    return Number.isFinite(value) && Number.isFinite(total) && total > 0
        ? Math.max(0, Math.min(100, Math.floor(value / total * 100))) : null;
}

export function terminalBar(progress, width = 20) {
    const filled = Math.round(Math.max(0, Math.min(100, progress)) / 100 * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}
