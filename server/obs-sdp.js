import sdp from 'sdp-transform';
import {isSameProfile, generateProfileLevelIdStringForAnswer} from 'h264-profile-level-id';
import {httpError} from './config.js';

const invalid = message => httpError(400, message || 'Invalid WHIP offer. Use one H.264 video track and optional Opus audio.');

export function parseObsOffer(text) {
  if (typeof text !== 'string' || !text.startsWith('v=0\r\n') || text.length > 65536) throw invalid();
  const offer = sdp.parse(text);
  const media = offer.media;
  if (!media?.length || media.length > 2 || !media.some(m => m.type === 'video') ||
      new Set(media.map(m => m.type)).size !== media.length) throw invalid();
  const mids = media.map(m => String(m.mid));
  const bundle = offer.groups?.find(group => group.type === 'BUNDLE');
  if (new Set(mids).size !== mids.length || !bundle || String(bundle.mids) !== mids.join(' ')) throw invalid();
  for (const m of media) {
    const fingerprint = m.fingerprint || offer.fingerprint;
    if (!['audio', 'video'].includes(m.type) || !/^[\w-]{1,32}$/.test(String(m.mid)) || m.mid === undefined ||
        (m.port === 0 && !m.bundleOnly) || m.protocol !== 'UDP/TLS/RTP/SAVPF' || !m.rtcpMux ||
        !['sendonly', 'sendrecv'].includes(m.direction || offer.direction) || m.simulcast || m.simulcast_03 || m.rids?.length ||
        !['actpass', 'active', 'passive'].includes(m.setup || offer.setup) ||
        !fingerprint || fingerprint.type !== 'sha-256' || !/^(?:[\da-f]{2}:){31}[\da-f]{2}$/i.test(fingerprint.hash) ||
        !/^[\w+/]{4,256}$/.test(m.iceUfrag || offer.iceUfrag || '') ||
        !/^[\w+/]{22,256}$/.test(m.icePwd || offer.icePwd || '')) throw invalid();
    const first = media[0];
    if ((m.iceUfrag || offer.iceUfrag) !== (first.iceUfrag || offer.iceUfrag) ||
        (m.icePwd || offer.icePwd) !== (first.icePwd || offer.icePwd) ||
        (m.setup || offer.setup) !== (first.setup || offer.setup) ||
        fingerprint.hash !== (first.fingerprint || offer.fingerprint).hash) throw invalid('WHIP tracks must share one bundled transport.');
  }
  return offer;
}

export function obsRtpParameters(media, capabilities) {
  let codec;
  for (const offered of media.rtp || []) {
    const mimeType = `${media.type}/${offered.codec}`;
    if (!['video/h264', 'audio/opus'].includes(mimeType.toLowerCase())) continue;
    const parameters = sdp.parseParams(media.fmtp?.find(f => f.payload === offered.payload)?.config || '');
    if (parameters['profile-level-id'] !== undefined) parameters['profile-level-id'] = String(parameters['profile-level-id']);
    const supported = capabilities.codecs.find(c => c.mimeType.toLowerCase() === mimeType.toLowerCase() &&
      c.clockRate === offered.rate && (media.type !== 'audio' || (offered.encoding || 1) === c.channels) &&
      (media.type !== 'video' || (Number(parameters['packetization-mode']) === 1 && isSameProfile(c.parameters, parameters))));
    if (!supported) continue;
    if (media.type === 'video') parameters['profile-level-id'] = generateProfileLevelIdStringForAnswer(supported.parameters, parameters);
    const rtcpFeedback = (media.rtcpFb || []).filter(f => (f.payload === offered.payload || f.payload === '*') &&
      supported.rtcpFeedback.some(s => s.type === f.type && (s.parameter || '') === (f.subtype || '')))
      .map(f => ({type: f.type, parameter: f.subtype || ''}));
    codec = {mimeType: supported.mimeType, payloadType: offered.payload, clockRate: offered.rate,
      ...(media.type === 'audio' ? {channels: supported.channels} : {}), parameters, rtcpFeedback};
    break;
  }
  if (!codec) throw httpError(406, 'Use H.264 Baseline video (no simulcast) and Opus stereo audio in OBS.');
  const repair = new Set((media.ssrcGroups || []).filter(g => g.semantics === 'FID').map(g => Number(g.ssrcs.split(' ')[1])));
  const sources = [...new Set((media.ssrcs || []).map(s => s.id))].filter(id => !repair.has(id));
  if (sources.length > 1 || sources.some(id => !Number.isInteger(id) || id <= 0 || id > 0xffffffff)) throw invalid();
  const headerExtensions = (media.ext || []).filter(ext => !ext['encrypt-uri'] &&
    capabilities.headerExtensions.some(s => s.kind === media.type && s.uri === ext.uri && s.direction !== 'sendonly'))
    .map(ext => ({uri: ext.uri, id: ext.value, encrypt: false, parameters: {}}));
  return {mid: String(media.mid), codecs: [codec], headerExtensions,
    encodings: [sources.length ? {ssrc: sources[0]} : {}],
    rtcp: {cname: media.ssrcs?.find(s => s.attribute === 'cname')?.value, reducedSize: true}};
}

export function obsAnswer(offer, transport, tracks) {
  const fingerprint = transport.dtlsParameters.fingerprints.find(f => f.algorithm === 'sha-256');
  return sdp.write({version: 0,
    origin: {username: 'helltube', sessionId: Date.now(), sessionVersion: 1, netType: 'IN', ipVer: 4, address: '0.0.0.0'},
    name: '-', timing: {start: 0, stop: 0}, icelite: 'ice-lite',
    groups: [{type: 'BUNDLE', mids: offer.media.map(m => m.mid).join(' ')}],
    msidSemantic: {semantic: 'WMS', token: '*'},
    media: offer.media.map((m, index) => {
      const {codecs, headerExtensions} = tracks[index];
      return {type: m.type, port: 7, protocol: 'UDP/TLS/RTP/SAVPF', payloads: codecs.map(c => c.payloadType).join(' '),
        connection: {version: 4, ip: '0.0.0.0'}, mid: String(m.mid), direction: 'recvonly',
        iceUfrag: transport.iceParameters.usernameFragment, icePwd: transport.iceParameters.password,
        fingerprint: {type: fingerprint.algorithm, hash: fingerprint.value},
        setup: (m.setup || offer.setup) === 'passive' ? 'active' : 'passive',
        candidates: transport.iceCandidates.map(c => ({foundation: c.foundation, component: 1, transport: c.protocol,
          priority: c.priority, ip: c.address || c.ip, port: c.port, type: c.type, ...(c.tcpType ? {tcptype: c.tcpType} : {})})),
        endOfCandidates: 'end-of-candidates', rtcpMux: 'rtcp-mux', ...(m.rtcpRsize ? {rtcpRsize: 'rtcp-rsize'} : {}),
        rtp: codecs.map(c => ({payload: c.payloadType, codec: c.mimeType.split('/')[1], rate: c.clockRate,
          ...(c.channels ? {encoding: c.channels} : {})})),
        fmtp: codecs.map(c => ({payload: c.payloadType, config: Object.entries(c.parameters).map(([k, v]) => `${k}=${v}`).join(';')})),
        rtcpFb: codecs.flatMap(c => c.rtcpFeedback.map(f => ({payload: c.payloadType, type: f.type, subtype: f.parameter}))),
        ext: headerExtensions.map(e => ({value: e.id, uri: e.uri})),
      };
    }),
  });
}
