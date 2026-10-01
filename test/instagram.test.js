import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingest, openStore, reply, graph, verifySignature } from '../src/core.js';
import { makeServer } from '../src/server.js';

const now = Date.now();
const env = { IG_ACCOUNT_ID: '123', TEST_RECIPIENT_ID: '456', IG_ACCESS_TOKEN: 'fake-token', META_GRAPH_VERSION: 'v24.0' };
const fixture = (timestamp = now) => ({ object: 'instagram', entry: [{ id: '123', messaging: [{ sender: { id: '456' }, recipient: { id: '123' }, timestamp, message: { mid: 'mid-test', text: 'RACANA-TEST' } }] }] });
const sign = raw => `sha256=${createHmac('sha256', 'test-secret').update(raw).digest('hex')}`;
const request = { mid: 'mid-test', text: 'Received!', requestId: 'test-request-001' };

test('signature rejects missing, malformed and altered bodies', () => {
  const raw = Buffer.from(JSON.stringify(fixture()));
  assert.equal(verifySignature(raw, sign(raw), 'test-secret'), true);
  assert.equal(verifySignature(raw, undefined, 'test-secret'), false);
  assert.equal(verifySignature(raw, 'sha256=x', 'test-secret'), false);
  assert.equal(verifySignature(Buffer.from('{}'), sign(raw), 'test-secret'), false);
});

test('signed webhook handshake, persistence, replay deduplication and input rejection', async t => {
  const db = openStore(':memory:');
  const server = makeServer({ accountId: '123', secret: 'test-secret', verifyToken: 'verify' }, db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let r = await fetch(`${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=hello`);
  assert.equal(await r.text(), 'hello');
  assert.equal((await fetch(`${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`)).status, 403);
  const raw = JSON.stringify(fixture());
  const post = (body, signature = sign(body)) => fetch(`${base}/webhooks/instagram`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }, body });
  assert.equal((await post(raw, 'sha256=bad')).status, 401);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(raw)).status, 200);
  assert.equal((await post(raw)).status, 200);
  assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, 1);
  assert.equal((await fetch(`${base}/api/messages`)).status, 404);
});

test('ignores wrong accounts, echoes, malformed timestamps and future events', () => {
  const db = openStore(':memory:');
  try {
    for (const mutate of [p => p.entry[0].id = '999', p => p.entry[0].messaging[0].message.is_echo = true,
      p => p.entry[0].messaging[0].recipient.id = '999', p => p.entry[0].messaging[0].timestamp = null,
      p => p.entry[0].messaging[0].timestamp = now + 120000]) {
      const p = fixture(); mutate(p); assert.equal(ingest(db, p, '123', now), 0);
    }
  } finally { db.close(); }
});

test('inbound records and duplicate protection survive database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'racana-'));
  try {
    const path = join(dir, 'test.sqlite');
    let db = openStore(path); ingest(db, fixture(), '123', now); db.close();
    db = openStore(path);
    assert.equal(ingest(db, fixture(), '123', now), 0);
    assert.equal(db.prepare('SELECT text FROM messages').get().text, 'RACANA-TEST'); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reply is tester-only, preserves recipient and prevents repeated sends', async () => {
  const db = openStore(':memory:'); let calls = 0;
  try {
    ingest(db, fixture(), '123', now);
    await assert.rejects(reply(db, { ...env, TEST_RECIPIENT_ID: '999' }, request), /configured test recipient/);
    const send = async (_, path, body) => {
      calls++; assert.equal(path, '123/messages'); assert.equal(body.recipient.id, '456'); return { message_id: 'out-1' };
    };
    assert.equal((await reply(db, env, request, send, now)).status, 'accepted');
    assert.equal((await reply(db, env, request, send, now)).message_id, 'out-1');
    assert.equal(calls, 1);
    await assert.rejects(reply(db, env, { ...request, text: 'different' }, send, now), /different content/);
  } finally { db.close(); }
});

test('old messages cannot reopen reply window when redelivered', async () => {
  const db = openStore(':memory:');
  try {
    ingest(db, fixture(now - 86400001), '123', now);
    await assert.rejects(reply(db, env, request, async () => assert.fail('must not send'), now), /24-hour/);
  } finally { db.close(); }
});

test('network uncertainty is durable and never automatically retried', async () => {
  const db = openStore(':memory:'); let calls = 0;
  try {
    ingest(db, fixture(), '123', now);
    const send = async () => { calls++; throw new Error('timeout'); };
    assert.equal((await reply(db, env, request, send, now)).status, 'uncertain');
    assert.equal((await reply(db, env, request, send, now)).status, 'uncertain');
    assert.equal(calls, 1);
  } finally { db.close(); }
});

test('Graph adapter uses bearer authorization and hides provider error text', async () => {
  await assert.rejects(graph(env, '123/messages', {}, async (url, opts) => {
    assert.equal(url, 'https://graph.instagram.com/v24.0/123/messages');
    assert.equal(opts.headers.Authorization, 'Bearer fake-token');
    return { ok: false, status: 400, json: async () => ({ error: { code: 190, message: 'SECRET raw error' } }) };
  }), error => error.message === 'Graph request failed (HTTP 400, code 190).' && error.definite);
});
