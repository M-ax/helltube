// Mirrors OBS/libdatachannel: bundled send-only tracks, fixed SSRCs, no trickle.
export function obsOffer({audio = true, videoCodec = 'H264'} = {}) {
    const fingerprint = Array(32).fill('AB').join(':');
    const session = ['v=0', 'o=- 1234 1 IN IP4 127.0.0.1', 's=-', 't=0 0',
        `a=group:BUNDLE ${audio ? 'audio video' : 'video'}`, 'a=msid-semantic: WMS obs',
        'a=ice-ufrag:obsTest', 'a=ice-pwd:obsTestPassword12345678901234',
        `a=fingerprint:sha-256 ${fingerprint}`, 'a=setup:actpass'];
    if (audio) session.push('m=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=mid:audio',
        'a=sendonly', 'a=rtcp-mux', 'a=rtpmap:111 opus/48000/2', 'a=ssrc:1234 cname:obs');
    session.push('m=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0', 'a=mid:video', 'a=sendonly', 'a=rtcp-mux',
        `a=rtpmap:96 ${videoCodec}/90000`, 'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1',
        'a=rtcp-fb:96 nack', 'a=rtcp-fb:96 nack pli', 'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=ssrc:1235 cname:obs');
    return session.join('\r\n') + '\r\n';
}
