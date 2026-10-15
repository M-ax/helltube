import {createHash, randomBytes} from 'node:crypto';
import {httpError} from './config.js';

export const REALTIME_TICKET_TTL = 30_000;
const key = ticket => createHash('sha256').update(ticket).digest('hex');

// Tickets authorize one upgrade, not subsequent connections or HTTP requests.
// Only their hashes are retained; the issuing login remains authoritative.
export class RealtimeTickets {
  constructor(accounts, {now = Date.now, maxPending = 5000, maxPerSession = 8} = {}) {
    Object.assign(this, {accounts, now, maxPending, maxPerSession});
    this.pending = new Map();
  }

  prune() {
    for (const [id, value] of this.pending) {
      if (value.expires <= this.now() || !this.accounts.authenticate(`session=${value.session}`)) this.pending.delete(id);
    }
  }

  issue(auth, origin) {
    this.prune();
    if (this.pending.size >= this.maxPending ||
        [...this.pending.values()].filter(value => value.session === auth.token).length >= this.maxPerSession) {
      throw httpError(429, 'Too many pending connections. Please retry shortly.');
    }
    const ticket = randomBytes(32).toString('hex');
    this.pending.set(key(ticket), {session: auth.token, origin, expires: this.now() + REALTIME_TICKET_TTL});
    return ticket;
  }

  consume(ticket, origin) {
    if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) return null;
    const id = key(ticket);
    const value = this.pending.get(id);
    if (!value) return null;
    if (value.expires <= this.now()) { this.pending.delete(id); return null; }
    if (value.origin !== origin) return null;
    this.pending.delete(id);
    return this.accounts.authenticate(`session=${value.session}`);
  }
}
