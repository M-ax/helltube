import {createWorker} from 'mediasoup';
import {isIP} from 'node:net';

const mediaCodecs = [
  {kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2},
  {kind: 'video', mimeType: 'video/VP8', clockRate: 90000},
  // Windows GPU encoders can expose Baseline but not Constrained Baseline.
  // Advertise both so browser capability probing can select the hardware path.
  {kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: {'packetization-mode': 1, 'profile-level-id': '42001f', 'level-asymmetry-allowed': 1}},
  {kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: {'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1}},
];

export function desktopRelayOptions(config) {
  const ip = config.desktopListenIp || '127.0.0.1';
  const announcedAddress = config.desktopAnnouncedAddress || undefined;
  const port = config.desktopPort ?? 44444;
  if (!isIP(ip)) throw new Error('DESKTOP_LISTEN_IP must be a local IPv4 or IPv6 address.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('DESKTOP_PORT must be between 0 and 65535.');
  if (announcedAddress && (typeof announcedAddress !== 'string' ||
      (!isIP(announcedAddress) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(announcedAddress)))) {
    throw new Error('DESKTOP_ANNOUNCED_ADDRESS must be an IP address or hostname, without a scheme or port.');
  }
  if (['0.0.0.0', '::'].includes(ip) && !announcedAddress) {
    throw new Error('DESKTOP_ANNOUNCED_ADDRESS is required when desktop media listens on all interfaces.');
  }
  return {listenInfos: ['udp', 'tcp'].map(protocol => ({protocol, ip,
    ...(port ? {port} : {}), ...(announcedAddress ? {announcedAddress} : {})}))};
}

// One native SFU worker and one shared UDP/TCP listener. Each desktop gets its
// own router, one publishing transport, and a receiving transport per viewer.
export class DesktopRelay {
  constructor(options, onFailure = () => {}) {
    Object.assign(this, {options, onFailure});
    this.closed = false;
  }

  async ready() {
    if (this.closed) throw new Error('Desktop relay is closed.');
    if (!this.initializing) {
      this.initializing = (async () => {
        const worker = await createWorker({logLevel: 'warn'});
        this.worker = worker;
        if (this.closed) { worker.close(); throw new Error('Desktop relay is closed.'); }
        worker.on('died', () => {
          if (this.worker !== worker) return;
          this.worker = this.webRtcServer = this.initializing = null;
          this.onFailure('The desktop relay stopped. Start a new share to reconnect.');
        });
        try { this.webRtcServer = await worker.createWebRtcServer(this.options); }
        catch (error) { worker.close(); throw error; }
        return worker;
      })().catch(error => { this.initializing = null; throw error; });
    }
    return this.initializing;
  }

  async createRouter() {
    const worker = await this.ready();
    return worker.createRouter({mediaCodecs});
  }

  async createTransport(router) {
    return router.createWebRtcTransport({webRtcServer: this.webRtcServer, enableUdp: true, enableTcp: true,
      preferUdp: true, initialAvailableOutgoingBitrate: 2_000_000, iceConsentTimeout: 30});
  }

  async close() {
    this.closed = true;
    try { await this.initializing; } catch { /* A failed startup has no live worker. */ }
    this.worker?.close();
    this.worker = this.webRtcServer = null;
  }
}
