import {get, writable} from 'svelte/store';

export function casterClient(bridge, onEvent = () => {}) {
    const state = writable({status: 'disconnected', joined: false, room: null, rooms: []});
    const desktopMessages = writable(null);
    let selectedRoom = null;
    const command = message => {
        if (get(state).status !== 'connected') return false;
        void bridge.command(message).then(sent => {
            if (!sent) state.update(value => ({...value, joined: false, status: 'disconnected'}));
        }).catch(() => state.update(value => ({...value, joined: false, status: 'disconnected'})));
        return true;
    };
    const unsubscribe = bridge.onEvent(message => {
        if (message.type === 'connection') state.update(value => ({...value, status: message.status, joined: false, room: null}));
        else if (message.type === 'rooms') {
            state.update(value => ({...value, rooms: message.rooms}));
            if (selectedRoom && !get(state).joined && message.rooms.some(room => room.id === selectedRoom)) command({type: 'join', roomId: selectedRoom});
        } else if (message.type === 'state') state.update(value => ({...value, room: message.room, joined: message.room.id === selectedRoom}));
        else if (message.type?.startsWith('desktop:')) desktopMessages.set(message);
        else if (message.type === 'session-ended') {
            selectedRoom = null; state.set({status: 'disconnected', joined: false, room: null, rooms: []});
        }
        if (message.type !== 'audio-data') onEvent(message);
    });
    return {state, desktopMessages, command,
        join(roomId) {
            selectedRoom = roomId;
            state.update(value => ({...value, room: null, joined: false}));
            return command({type: 'join', roomId});
        },
        reset() { selectedRoom = null; state.set({status: 'disconnected', joined: false, room: null, rooms: []}); },
        dispose: unsubscribe};
}
