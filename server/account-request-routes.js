import { publicUser } from './auth.js';
import { httpError } from './config.js';
import { publicRequest, requestAge } from './account-requests.js';

export function accountRequestRoutes(app, { requests, accounts, identify, admin, limit, clientIP, cookie, config, capabilities }) {
  const receipt = req => (req.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith('account_request='))?.slice('account_request='.length);
  const requestCookie = token => `account_request=${token}; HttpOnly; SameSite=Strict; Path=/api/account-requests; Max-Age=${token ? requestAge / 1000 : 0}${config.secureCookies ? '; Secure' : ''}`;
  const streams = new Set();

  app.post('/api/account-requests', async (req, res) => {
    limit(`account-request:${clientIP(req)}`, 5, 60 * 60 * 1000);
    const result = await requests.submit(req.body, receipt(req));
    res.set('Set-Cookie', requestCookie(result.token)).status(201).json({ request: result.request });
  });
  app.get('/api/account-requests/current', (req, res) => {
    const request = requests.current(receipt(req));
    res.json({ request: request ? publicRequest(request) : null });
  });
  app.post('/api/account-requests/claim', (req, res) => {
    limit(`account-claim:${clientIP(req)}`, 30);
    const { user, token } = requests.claim(receipt(req));
    res.set('Set-Cookie', [cookie(token), requestCookie('')]).json({ user: publicUser(user), capabilities });
  });
  app.get('/api/account-requests', identify, admin, (_req, res) => res.json({ requests: requests.list() }));
  for (const [action, status] of [['approve', 'approved'], ['deny', 'denied']]) {
    app.post(`/api/account-requests/:id/${action}`, identify, admin, (req, res) => {
      limit(`account:${req.auth.user.id}`, 20);
      res.json({ request: requests.decide(req.params.id, status, req.auth.user) });
    });
  }

  function stream(res, owner, snapshot) {
    if (streams.size >= 500 || [...streams].filter(value => value.owner === owner).length >= 4) {
      throw httpError(429, 'Too many live account request connections. Close another tab and try again.');
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const entry = { owner, res, snapshot };
    streams.add(entry);
    res.on('close', () => streams.delete(entry));
    res.write('retry: 3000\n\n');
    publish(entry);
  }
  function publish(entry) {
    if (entry.res.destroyed || entry.res.writableEnded || entry.res.writableLength > 256 * 1024) {
      streams.delete(entry);
      if (!entry.res.writableEnded) entry.res.destroy();
      return;
    }
    const data = entry.snapshot();
    entry.res.write(`event: account-requests\ndata: ${JSON.stringify(data)}\n\n`);
    if (data === null) {
      streams.delete(entry);
      entry.res.end();
    }
  }
  app.get('/api/account-requests/current/events', (req, res) => {
    const token = receipt(req);
    const request = requests.current(token);
    if (!request) throw httpError(404, 'Account request not found or expired.');
    stream(res, `request:${request.id}`, () => {
      const current = requests.current(token);
      return current ? { request: publicRequest(current) } : null;
    });
  });
  app.get('/api/account-requests/events', identify, admin, (req, res) => {
    stream(res, `admin:${req.auth.user.id}`, () => {
      if (accounts.authenticate(req.headers.cookie)?.user.role !== 'admin') return null;
      return { requests: requests.list() };
    });
  });
  const publishAll = () => { for (const entry of streams) publish(entry); };
  requests.on('change', publishAll);
  const heartbeat = setInterval(() => { requests.prune(); publishAll(); }, 15000);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    requests.off('change', publishAll);
    for (const entry of streams) entry.res.end();
    streams.clear();
  };
}
