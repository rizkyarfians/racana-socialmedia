import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}. Configure your local .env.`);
  return value;
}
export function config(env = process.env) {
  const accountId = required(env, 'IG_ACCOUNT_ID');
  if (!/^\d+$/.test(accountId)) throw new Error('IG_ACCOUNT_ID must be numeric.');
  return { accountId, secret: required(env, 'META_APP_SECRET'),
    verifyToken: required(env, 'WEBHOOK_VERIFY_TOKEN'),
    dbPath: env.DB_PATH || './data/instagram.sqlite' };
}
export function equal(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}
export function verifySignature(raw, signature, secret) {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature || '')) return false;
  return equal(signature, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
}
export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS messages (
      mid TEXT PRIMARY KEY, account_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      text TEXT NOT NULL, timestamp INTEGER NOT NULL, received_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replies (
      request_id TEXT PRIMARY KEY, inbound_mid TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT,
      error_code TEXT, created_at INTEGER NOT NULL
    );`);
  return db;
}
export function ingest(db, payload, accountId, now = Date.now()) {
  if (payload?.object !== 'instagram' || !Array.isArray(payload.entry)) return 0;
  let inserted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of payload.entry) {
      if (String(entry?.id) !== accountId || !Array.isArray(entry.messaging)) continue;
      for (const event of entry.messaging) {
        const m = event?.message;
        if (!m || m.is_echo || m.is_deleted || typeof m.mid !== 'string' || !m.mid) continue;
        const sender = String(event.sender?.id || '');
        if (!/^\d+$/.test(sender) || sender === accountId || String(event.recipient?.id) !== accountId) continue;
        // Preserve event time: replayed notifications must not reopen the reply window.
        if (!Number.isSafeInteger(event.timestamp) || event.timestamp <= 0 || event.timestamp > now + 60000) continue;
        const text = typeof m.text === 'string' ? m.text : '[Non-text message; inspect in Instagram]';
        inserted += Number(db.prepare(`INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, ?)`)
          .run(m.mid, accountId, sender, text, event.timestamp, now).changes);
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return inserted;
}
export function listMessages(db, accountId) {
  return db.prepare('SELECT * FROM messages WHERE account_id = ? ORDER BY timestamp DESC LIMIT 50').all(accountId);
}
export async function graph(env, path, body, fetchImpl = fetch) {
  const version = required(env, 'META_GRAPH_VERSION');
  if (!/^v\d+\.\d+$/.test(version)) throw new Error('Invalid META_GRAPH_VERSION.');
  const token = required(env, 'IG_ACCESS_TOKEN');
  const response = await fetchImpl(`https://graph.instagram.com/${version}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Uncertain Graph response; inspect Instagram before any new send.'); }
  if (!response.ok || data.error) {
    // Never log raw provider messages, URLs, tokens, or payloads.
    const code = Number(data.error?.code) || response.status;
    const error = new Error(`Graph request failed (HTTP ${response.status}, code ${code}).`);
    error.code = String(code);
    error.definite = response.status >= 400 && response.status < 500 && !!data.error;
    throw error;
  }
  return data;
}
export async function reply(db, env, { mid, text, requestId }, send = graph, now = Date.now()) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId || '')) throw new Error('Use a unique --request value (8–100 letters/digits/_/-).');
  if (typeof text !== 'string' || !text.trim() || [...text].length > 1000) throw new Error('Reply must contain 1–1000 characters.');
  const accountId = required(env, 'IG_ACCOUNT_ID');
  const tester = required(env, 'TEST_RECIPIENT_ID');
  // Validate send configuration before reserving an attempt.
  required(env, 'IG_ACCESS_TOKEN');
  if (!/^v\d+\.\d+$/.test(required(env, 'META_GRAPH_VERSION'))) throw new Error('Invalid META_GRAPH_VERSION.');
  const inbound = db.prepare('SELECT * FROM messages WHERE mid = ? AND account_id = ?').get(mid, accountId);
  if (!inbound || inbound.sender_id !== tester) throw new Error('Message must belong to the configured test recipient.');
  const latest = db.prepare('SELECT MAX(timestamp) AS time FROM messages WHERE account_id = ? AND sender_id = ?').get(accountId, tester);
  if (latest.time > now || now - latest.time >= 24 * 60 * 60 * 1000) throw new Error('Outside this prototype’s 24-hour reply window; send a new test DM first.');
  const old = db.prepare('SELECT * FROM replies WHERE request_id = ?').get(requestId);
  if (old) {
    if (old.inbound_mid !== mid || old.text !== text) throw new Error('Request ID already used with different content.');
    return old;
  }
  // Unique request ID also prevents two CLI processes from sending the same operation.
  db.prepare('INSERT INTO replies VALUES (?, ?, ?, ?, NULL, NULL, ?)').run(requestId, mid, text, 'sending', now);
  try {
    const data = await send(env, `${accountId}/messages`, { recipient: { id: tester }, message: { text } });
    if (typeof data.message_id !== 'string' || !data.message_id) throw new Error('Missing message ID; delivery is uncertain.');
    db.prepare('UPDATE replies SET status = ?, message_id = ? WHERE request_id = ?').run('accepted', data.message_id, requestId);
  } catch (error) {
    db.prepare('UPDATE replies SET status = ?, error_code = ? WHERE request_id = ?')
      .run(error.definite ? 'failed' : 'uncertain', /^\d+$/.test(error.code || '') ? error.code : 'transport_or_response', requestId);
  }
  return db.prepare('SELECT * FROM replies WHERE request_id = ?').get(requestId);
}
