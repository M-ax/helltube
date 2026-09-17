// mediasoup carries a single publishing connection to metal. All negotiation
// stays scoped to this capture/subscription on the authenticated room socket.
export function createDesktopPeer({client, connection, stream, Stream = globalThis.MediaStream,
    loadDevice = async () => (await import('mediasoup-client')).Device.factory(),
    onStream = () => {}, onState = () => {}, requestTimeout = 15000}) {
    let closed = false;
    let device;
    let transport;
    let work = Promise.resolve();
    const received = stream ? null : new Stream();
    const requests = new Map();
    const producers = new Map();
    const consumers = new Map();
    const wanted = new Map((connection.producers || []).map(value => [value.id, value]));
    const removed = new Set();
    const identity = {requestId: connection.requestId, itemId: connection.itemId, peerId: connection.peerId};

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
            const options = {...connection.transportOptions, ...connection.rtcConfig};
            transport = stream ? device.createSendTransport(options) : device.createRecvTransport(options);
            transport.on('connect', ({dtlsParameters}, callback, errback) => {
                request('connect', {dtlsParameters}).then(callback, errback);
            });
            transport.on('connectionstatechange', status => { if (!closed) onState(status); });
            if (stream) {
                transport.on('produce', ({kind, rtpParameters}, callback, errback) => {
                    request('produce', {kind, rtpParameters}).then(callback, errback);
                });
                for (const track of stream.getTracks()) {
                    if (track.readyState !== 'live') continue;
                    active();
                    const producer = await transport.produce({track, stopTracks: false,
                        ...(track.kind === 'video' ? {encodings: [{maxBitrate: 6_000_000, maxFramerate: 30}],
                            codecOptions: {videoGoogleStartBitrate: 2000}} : {codecOptions: {opusStereo: true, opusMaxAverageBitrate: 128000}})});
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
        },
        async restartIce() {
            const options = await request('restart-ice');
            active();
            await transport.restartIce(options);
        },
        close() {
            if (closed) return;
            closed = true;
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
