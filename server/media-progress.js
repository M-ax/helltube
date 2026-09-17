// FFmpeg writes key=value records across arbitrary stdout chunks. Publish only
// complete records and only numeric fields intended for the room's status UI.
export function createProgressReader(onProgress) {
  let pending = '';
  let record = {};
  return chunk => {
    pending += chunk.toString();
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      const separator = line.indexOf('=');
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (key === 'out_time_us' && /^\d+$/.test(value)) record.seconds = Number(value) / 1e6;
      if (key === 'speed' && /^\d+(\.\d+)?x$/.test(value)) record.speed = Number(value.slice(0, -1));
      if (key === 'progress') {
        onProgress(record);
        record = {};
      }
    }
    // Defensive bound in case a misconfigured executable writes something else.
    if (pending.length > 8192) pending = '';
  };
}
