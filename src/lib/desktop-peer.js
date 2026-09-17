import {desktopVideoCodecs, desktopVideoEncoding} from './desktop-encoding.js';
import {createDesktopStats} from './desktop-stats.js';

// mediasoup carries a single publishing connection to metal. All negotiation
// stays scoped to this capture/subscription on the authenticated room socket.
export function createDesktopPeer({client, connection, stream, Stream = globalThis.MediaStream,
    loadDevice = async () => (await import('mediasoup-client')).Device.factory(),
    onStream = () => {}, onState = () => {}, onStats = () => {}, requestTimeout = 15000,
    mediaCapabilities = globalThis.navigator?.mediaCapabilities}) {
    let closed = false;
    let device;
    let transport;
    let statsTimer;
    const stats = createDesktopStats({outbound: !!stream});
    let work = Promise.resolve();
    const received = stream ? null : new Stream();
    const requests = new Map();
    const producers = new Map();
    const consumers = new Map();
    const wanted = new Map((connection.producers || []).map(value => [value.id, value]));
    const removed = new Set();
    const identity = {requestId: connection.requestId, itemId: connection.itemId, peerId: connection.peerId};
    let signalingFailed = false;

    async function sampleStats() {
        const current = transport;
        try {
            const report = await current.getStats();
            // A receiving transport also contains mediasoup's video probator.
            // Only the real consumer's negotiated SSRC describes the desktop.
            const consumer = [...consumers.values()].find(value => value.kind === 'video');
            const ssrc = consumer?.rtpParameters.encodings?.[0]?.ssrc;
            if (!closed && transport === current) onStats(stats.sample(!stream && ssrc === undefined ? null : report, {ssrc}));
        } catch {
            // Diagnostics are optional and must never interrupt desktop media.
            if (!closed && transport === current) onStats(stats.sample(null));
        } finally {
            if (!closed) statsTimer = setTimeout(sampleStats, 1000);
        }
    }

    function createTransport(transportOptions) {
        const options = {...transportOptions, ...connection.rtcConfig};
        const current = stream ? device.createSendTransport(options) : device.createRecvTransport(options);
        transport = current;
        const signal = (action, data, callback, errback) => request(action, data).then(callback, error => {
            signalingFailed = true;
            errback(error);
        });
        current.on('connect', ({dtlsParameters}, callback, errback) => signal('connect', {dtlsParameters}, callback, errback));
        current.on('connectionstatechange', status => { if (!closed && transport === current) onState(status); });
        if (stream) current.on('produce', ({kind, rtpParameters}, callback, errback) => signal('produce', {kind, rtpParameters}, callback, errback));
    }

    async function produceVideo(track) {
        const codecs = await desktopVideoCodecs(device.sendRtpCapabilities?.codecs, track, {mediaCapabilities});
        const choices = codecs.length ? codecs : [undefined];
        for (let index = 0; index < choices.length; index++) {
            active();
            try {
                return await transport.produce({track, stopTracks: false, codec: choices[index],
                    encodings: [{...desktopVideoEncoding}], codecOptions: {videoGoogleStartBitrate: 2000}});
            } catch (error) {
                active();
                if (signalingFailed || track.readyState === 'ended' || transport.closed || index === choices.length - 1) throw error;
                // A failed SDP operation can leave the browser transport unusable.
                // Retry on fresh transports at both ends, keeping the capture alive.
                const previous = transport;
                transport = null;
                previous.close();
                const options = await request('retry-video');
                active();
                createTransport(options);
            }
        }
    }

    function active() { if (closed) throw new Error('Desktop connection closed.'); }
    function request(action, data = {}) {
        if (closed) return Promise.reject(new Error('Desktop connection closed.'));
        const rpcId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                requests.delete(rpcId);
                reject(new Error('The metal desktop relay did not respond. Retry playback.'));
            }, requestTimeout);
            requests.set(rpcId, {resolve, reject, timer});
            if (!client.command({type: 'desktop:request', ...identity, rpcId, action, ...data})) {
                requests.delete(rpcId);
                clearTimeout(timer);
                reject(new Error('The room connection was lost.'));
            }
        });
    }

    function consumeTracks() {
        work = work.then(async () => {
            if (!transport || closed) return;
            for (const producer of wanted.values()) {
                if (closed || consumers.has(producer.id) || removed.has(producer.id)) continue;
                try {
                    const options = await request('consume', {producerId: producer.id, rtpCapabilities: device.recvRtpCapabilities});
                    active();
                    const consumer = await transport.consume({...options, streamId: connection.itemId});
                    if (closed || removed.has(producer.id)) { consumer.close(); continue; }
                    consumers.set(producer.id, consumer);
                    try {
                        if ('jitterBufferTarget' in consumer.rtpReceiver) consumer.rtpReceiver.jitterBufferTarget = 0;
                    } catch { /* Optional browser API. */ }
                    received.addTrack(consumer.track);
                    onStream(received);
                    // Resume only after the browser installed the consumer, so
                    // its initial keyframe is not lost during negotiation.
                    await request('resume', {consumerId: consumer.id});
                } catch (error) {
                    if (!closed && !removed.has(producer.id)) throw error;
                }
            }
        });
        return work;
    }

    const unsubscribe = client.desktopMessages.subscribe(message => {
        if (closed || !message || message.requestId !== identity.requestId) return;
        if (message.rpcId && requests.has(message.rpcId)) {
            const pending = requests.get(message.rpcId);
            requests.delete(message.rpcId);
            clearTimeout(pending.timer);
            if (message.type === 'desktop:error') pending.reject(new Error(message.message));
            else pending.resolve(message.data);
        } else if (message.type === 'desktop:available') {
            for (const producer of message.producers) wanted.set(producer.id, producer);
            if (transport) void consumeTracks().catch(() => { if (!closed) onState('failed'); });
        } else if (message.type === 'desktop:producer-closed') {
            removed.add(message.producerId);
            wanted.delete(message.producerId);
            const consumer = consumers.get(message.producerId);
            if (consumer) {
                received.removeTrack(consumer.track);
                consumer.close();
                consumers.delete(message.producerId);
                onStream(received);
            }
        }
    });

    return {
        async start() {
            device = await loadDevice();
            active();
            await device.load({routerRtpCapabilities: connection.routerRtpCapabilities});
            active();
            createTransport(connection.transportOptions);
            if (stream) {
                // Negotiate video before publishing audio, so codec retries cannot
                // tear down a successfully published audio track.
                const tracks = [...stream.getTracks()].sort((a, b) => Number(b.kind === 'video') - Number(a.kind === 'video'));
                for (const track of tracks) {
                    if (track.readyState !== 'live') continue;
                    active();
                    const producer = track.kind === 'video' ? await produceVideo(track) :
                        await transport.produce({track, stopTracks: false, codecOptions: {opusStereo: true, opusMaxAverageBitrate: 128000}});
                    if (closed) { producer.close(); return; }
                    producers.set(track.kind, producer);
                    const endAudio = () => {
                        if (closed || track.kind !== 'audio' || !producers.has('audio')) return;
                        producers.delete('audio');
                        producer.close();
                        void request('close-producer', {producerId: producer.id}).catch(() => {});
                    };
                    producer.on('trackended', endAudio);
                    if (track.readyState !== 'live') endAudio();
                }
                active();
                await request('ready');
            } else await consumeTracks();
            if (!closed) void sampleStats();
        },
        async restartIce() {
            const options = await request('restart-ice');
            active();
            await transport.restartIce(options);
        },
        close() {
            if (closed) return;
            closed = true;
            clearTimeout(statsTimer);
            unsubscribe();
            for (const pending of requests.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error('Desktop connection closed.'));
            }
            requests.clear();
            transport?.close();
            received?.getTracks().forEach(track => track.stop());
            consumers.clear();
            producers.clear();
            wanted.clear();
        },
    };
}
