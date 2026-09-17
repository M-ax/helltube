import {createHmac} from 'node:crypto';

export function desktopRtcConfig(config, now = Date.now) {
  let servers;
  try { servers = JSON.parse(config.desktopIceServers || '[]'); }
  catch { throw new Error('DESKTOP_ICE_SERVERS must be a JSON array of WebRTC ICE servers.'); }
  if (!Array.isArray(servers) || servers.length > 16) throw new Error('DESKTOP_ICE_SERVERS must contain at most 16 servers.');
  servers = servers.map(server => {
    const urls = typeof server?.urls === 'string' ? [server.urls] : server?.urls;
    if (!Array.isArray(urls) || !urls.length || urls.some(url => typeof url !== 'string' || !/^(stun|stuns|turn|turns):[^\s]+$/.test(url))) {
      throw new Error('DESKTOP_ICE_SERVERS requires valid stun:/turn: URLs.');
    }
    if (urls.some(url => /^turns?:/.test(url)) && !config.desktopTurnSecret &&
        !(typeof server.username === 'string' && typeof server.credential === 'string' && server.credential)) {
      throw new Error('TURN servers require DESKTOP_TURN_SECRET or username/credential.');
    }
    return {urls, ...(typeof server.username === 'string' ? {username: server.username} : {}),
      ...(typeof server.credential === 'string' ? {credential: server.credential} : {})};
  });
  const policy = config.desktopIceTransportPolicy || 'all';
  if (!['all', 'relay'].includes(policy)) throw new Error('DESKTOP_ICE_TRANSPORT_POLICY must be all or relay.');
  if (policy === 'relay' && !servers.some(server => server.urls.some(url => /^turns?:/.test(url)))) {
    throw new Error('Relay-only desktop sharing requires a TURN server.');
  }
  return connectionId => {
    // coturn REST credentials outlive the four-hour share limit, including late
    // joins/retries. The shared secret never leaves the backend.
    const username = `${Math.floor(now() / 1000) + 5 * 60 * 60}:${connectionId}`;
    return {iceTransportPolicy: policy, iceServers: servers.map(server =>
      config.desktopTurnSecret && server.urls.some(url => /^turns?:/.test(url))
        ? {...server, username, credential: createHmac('sha1', config.desktopTurnSecret).update(username).digest('base64')}
        : {...server})};
  };
}
