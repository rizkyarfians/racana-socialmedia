import { parseArgs } from 'node:util';
import { config, graph, listMessages, openStore, reply } from './core.js';

process.umask(0o077);
let db;
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    mid: { type: 'string' }, text: { type: 'string' }, request: { type: 'string' }, confirm: { type: 'boolean' }
  } });
  const command = positionals[0];
  if (!['check', 'subscribe', 'inbox', 'reply', 'attempts'].includes(command))
    throw new Error('Commands: check | subscribe --confirm | inbox | attempts | reply --mid ID --text TEXT --request UNIQUE_ID --confirm');
  const cfg = config();
  if (command === 'check') {
    const data = await graph(process.env, `${cfg.accountId}?fields=id,user_id,username`);
    if (![data.id, data.user_id].some(id => String(id) === cfg.accountId)) throw new Error('Account ID mismatch.');
    console.info(JSON.stringify({ connected: true, id: data.id, user_id: data.user_id, username: data.username }, null, 2));
  } else if (command === 'subscribe') {
    if (!values.confirm) throw new Error('Add --confirm to subscribe this account to message webhooks.');
    const data = await graph(process.env, `${cfg.accountId}/subscribed_apps`, { subscribed_fields: ['messages'] });
    if (data.success !== true) throw new Error('Subscription not confirmed by Meta.');
    console.info('Account subscription confirmed. Also configure the callback and messages field in the Meta dashboard.');
  } else {
    db = openStore(cfg.dbPath);
    if (command === 'inbox') console.info(JSON.stringify(listMessages(db, cfg.accountId), null, 2));
    if (command === 'attempts') console.info(JSON.stringify(db.prepare(`SELECT r.request_id, r.status, r.message_id, r.error_code, r.created_at FROM replies r JOIN messages m ON m.mid = r.inbound_mid WHERE m.account_id = ? ORDER BY r.created_at DESC LIMIT 50`).all(cfg.accountId), null, 2));
    if (command === 'reply') {
      if (!values.confirm) throw new Error('Add --confirm to send a real reply to the configured tester.');
      const result = await reply(db, process.env, { mid: values.mid, text: values.text, requestId: values.request });
      console.info(JSON.stringify({ request_id: result.request_id, status: result.status, message_id: result.message_id, error_code: result.error_code }, null, 2));
      if (result.status !== 'accepted') process.exitCode = 1;
      console.info('accepted means API acceptance, not confirmed delivery. Verify in the tester inbox. Never blindly retry uncertain/sending attempts.');
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db?.close(); }
