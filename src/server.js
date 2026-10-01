import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { config, equal, ingest, openStore, verifySignature } from './core.js';

export function makeServer(cfg, db) {
  return createServer(async (req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return respond(200, 'ok');
      if (url.pathname !== '/webhooks/instagram') return respond(404, 'Not found');
      if (req.method === 'GET') {
        const q = url.searchParams;
        if (q.get('hub.mode') === 'subscribe' && equal(q.get('hub.verify_token'), cfg.verifyToken) && q.has('hub.challenge'))
          return respond(200, q.get('hub.challenge'));
        return respond(403, 'Verification failed');
      }
      if (req.method !== 'POST') return respond(405, 'Method not allowed');
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) return respond(415, 'JSON required');
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { respond(413, 'Payload too large'); req.resume(); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (!verifySignature(raw, req.headers['x-hub-signature-256'], cfg.secret)) return respond(401, 'Invalid signature');
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { return respond(400, 'Invalid JSON'); }
      const inserted = ingest(db, payload, cfg.accountId);
      // Acknowledge only after transaction commits. No message bodies/tokens in logs.
      if (inserted) console.info(JSON.stringify({ event: 'messages_stored', count: inserted }));
      return respond(200, 'EVENT_RECEIVED');
    } catch {
      console.error('Webhook processing failed. No payload logged.');
      if (!res.headersSent) respond(500, 'Processing failed');
      else res.end();
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.umask(0o077);
    const cfg = config();
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
    const db = openStore(cfg.dbPath);
    const server = makeServer(cfg, db);
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.on('error', () => { console.error('Unable to listen on configured host/port.'); db.close(); process.exitCode = 1; });
    server.listen(port, process.env.HOST || '127.0.0.1', () => console.info(`Webhook server listening on port ${port}`));
    const stop = () => server.close(() => { db.close(); process.exit(0); });
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
