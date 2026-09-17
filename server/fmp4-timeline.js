import {open} from 'node:fs/promises';

const invalid = () => new Error('Cannot determine the copied stream timeline.');

function boxes(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw invalid();
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const header = size === 1 ? 16 : 8;
    if (offset + header > bytes.length) throw invalid();
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    else if (size === 0) size = bytes.length - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > bytes.length) throw invalid();
    result.push({type, data: bytes.subarray(offset + header, offset + size)});
    offset += size;
  }
  return result;
}

function child(bytes, type) {
  const box = boxes(bytes).find(box => box.type === type);
  if (!box) throw invalid();
  return box.data;
}

// Read only the requested metadata box, skipping large media payloads.
async function fileBox(file, type) {
  const handle = await open(file, 'r');
  try {
    const {size: fileSize} = await handle.stat();
    const header = Buffer.alloc(16);
    for (let offset = 0, count = 0; offset + 8 <= fileSize && count < 32; count++) {
      const {bytesRead} = await handle.read(header, 0, 16, offset);
      let size = header.readUInt32BE(0);
      const length = size === 1 ? 16 : 8;
      if (bytesRead < length) throw invalid();
      if (size === 1) size = Number(header.readBigUInt64BE(8));
      else if (size === 0) size = fileSize - offset;
      if (!Number.isSafeInteger(size) || size < length || offset + size > fileSize) throw invalid();
      if (header.toString('ascii', 4, 8) === type) {
        if (size > 4 * 1024 * 1024) throw invalid();
        const data = Buffer.alloc(size - length);
        if ((await handle.read(data, 0, data.length, offset + length)).bytesRead !== data.length) throw invalid();
        return data;
      }
      offset += size;
    }
    throw invalid();
  } finally { await handle.close(); }
}

// With -copyts -start_at_zero, tfdt retains the source's normalized decode time.
// HLS playback maps the earliest populated track's decode time to local time zero.
export async function fmp4Timeline(initFile, segmentFile) {
  const [moov, moof] = await Promise.all([fileBox(initFile, 'moov'), fileBox(segmentFile, 'moof')]);
  const scales = new Map();
  for (const track of boxes(moov).filter(box => box.type === 'trak')) {
    if (boxes(track.data).some(box => box.type === 'edts')) throw invalid();
    const tkhd = child(track.data, 'tkhd');
    const mdia = child(track.data, 'mdia');
    const mdhd = child(mdia, 'mdhd');
    if (![0, 1].includes(tkhd[0]) || ![0, 1].includes(mdhd[0])) throw invalid();
    scales.set(tkhd.readUInt32BE(tkhd[0] === 1 ? 20 : 12), {
      scale: mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12), type: child(mdia, 'hdlr').toString('ascii', 8, 12),
    });
  }
  const times = [];
  for (const track of boxes(moof).filter(box => box.type === 'traf')) {
    if (!boxes(track.data).some(box => box.type === 'trun' && box.data.readUInt32BE(4) > 0)) continue;
    const {scale, type} = scales.get(child(track.data, 'tfhd').readUInt32BE(4)) || {};
    const tfdt = child(track.data, 'tfdt');
    if (tfdt[0] !== 0 && tfdt[0] !== 1) throw invalid();
    const ticks = tfdt[0] === 1 ? Number(tfdt.readBigUInt64BE(4)) : tfdt.readUInt32BE(4);
    if (!scale || !Number.isSafeInteger(ticks)) throw invalid();
    times.push({time: ticks / scale, type});
  }
  const video = times.find(track => track.type === 'vide');
  if (!video) throw invalid();
  const baseTime = Math.min(...times.map(track => track.time));
  // EXTINF is measured from video; include any earlier audio in the first entry.
  return {baseTime, leadingDuration: video.time - baseTime};
}
