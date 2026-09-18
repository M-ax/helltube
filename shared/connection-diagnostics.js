export const MAX_DISCONNECT_REPORTS = 20;
export const DISCONNECT_CAUSES = new Set([
  'socket-close', 'socket-error', 'send-error', 'connection-error',
  'connection-timeout', 'response-timeout', 'browser-offline', 'manual-retry',
]);

// Error/close text can contain URLs or line breaks. Keep journal entries bounded
// and on one line, without recording URL credentials, query strings or fragments.
export function diagnosticText(value, max = 256) {
  return typeof value === 'string'
    ? value.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[url]')
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, max)
    : '';
}

export function closeDetails(event) {
  return {
    code: Number.isInteger(event?.code) ? event.code : null,
    reason: diagnosticText(event?.reason, 123),
    wasClean: typeof event?.wasClean === 'boolean' ? event.wasClean : null,
  };
}
