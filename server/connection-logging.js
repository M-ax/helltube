import {diagnosticText, DISCONNECT_CAUSES} from '../shared/connection-diagnostics.js';
import {httpError} from './config.js';

const id = value => typeof value === 'string' && /^[\w.-]{1,80}$/.test(value);
const duration = value => value === null || (Number.isSafeInteger(value) && value >= 0);

export function disconnectReport(value) {
  if (!value || !id(value.id) || !DISCONNECT_CAUSES.has(value.cause) ||
    !Number.isSafeInteger(value.at) || value.at < 0 ||
    !duration(value.connectionAgeMs) || !duration(value.lastResponseAgeMs) ||
    !Number.isSafeInteger(value.attempt) || value.attempt < 0 ||
    !Number.isSafeInteger(value.droppedReports) || value.droppedReports < 0 ||
    ![null, true, false].includes(value.online) || ![null, true, false].includes(value.wasClean) ||
    !['visible', 'hidden', 'prerender', 'unknown'].includes(value.visibility) ||
    ![null, 0, 1, 2, 3].includes(value.readyState) ||
    !(value.code === null || (Number.isInteger(value.code) && value.code >= 1000 && value.code <= 4999)) ||
    !(value.connectionId === null || id(value.connectionId)) ||
    !(value.roomId === null || id(value.roomId))) throw httpError(400, 'Invalid disconnect report.');
  // Explicitly allow only diagnostic fields; identity comes from authentication.
  return {
    id: value.id, cause: value.cause, at: value.at,
    connectionId: value.connectionId, roomId: value.roomId,
    connectionAgeMs: value.connectionAgeMs, lastResponseAgeMs: value.lastResponseAgeMs,
    attempt: value.attempt, droppedReports: value.droppedReports,
    online: value.online, visibility: value.visibility, readyState: value.readyState,
    code: value.code, reason: diagnosticText(value.reason, 123), wasClean: value.wasClean,
    error: diagnosticText(value.error),
  };
}

export function logConnection(event, ws, details = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(), event,
    connectionId: ws.id, userId: ws.userId, username: diagnosticText(ws.username, 80),
    roomId: ws.roomId || ws.lastRoomId || null,
    connectionAgeMs: Math.max(0, Math.round(performance.now() - ws.connectedAt)),
    ...details,
  }));
}
