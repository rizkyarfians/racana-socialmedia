# Racana Social Media — Instagram messaging prototype

Milestone 1: receive a real Instagram DM through a signed webhook, persist it,
and explicitly reply through the Instagram API with Instagram Login.

**Status: local automated tests pass. No real Instagram account connected, no real
DM sent or received, and no deployment performed yet.** Those checks require the
owner's Meta app, Instagram authorization and a reachable HTTPS callback.

## Scope

- Dependency-free Node.js 24 backend; built-in SQLite on a persistent local disk.
- Signed webhook verification; account filtering; message ID deduplication.
- Terminal inbox and explicit reply command, restricted to one configured tester.
- Durable outgoing attempt statuses; no automatic retry of uncertain sends.
- No public inbox or public send endpoint. Public routes: health + webhook only.

This is a disposable integration spike before the React/TypeScript/PostgreSQL app.
It does not implement OAuth onboarding, token refresh, attachments, multi-user auth,
queues, historical inbox import, automatic replies, publishing or the full CRM.
Use a dedicated test account. No production/customer onboarding is claimed.

## Requirements

1. Node.js **24.x** (uses built-in `node:sqlite`; no npm install needed).
2. An Instagram Professional account (Business or Creator).
3. A Meta developer app configured for **Instagram API with Instagram Login**.
4. A token authorized by that account with `instagram_business_basic` and
   `instagram_business_manage_messages`. Use the app dashboard's supported test-token
   flow for this spike; respect its role/tester requirements and token expiry.
5. A second account you control, permitted by the app's current testing setup.
6. A public HTTPS callback forwarding to the local server, or a server with a
   persistent disk and HTTPS reverse proxy. A local terminal server alone is not
   reachable by Meta. The tunnel/hosting is not provisioned by this repository.

A Facebook Page is not required for this Instagram Login integration. Do not mix
Page access tokens / Facebook Login permissions with this route. Exact dashboard
labels and supported API versions can change; follow your app's current setup.

## Windows PowerShell setup

```powershell
git clone https://github.com/rizkyarfians/racana-socialmedia.git
cd racana-socialmedia
# If the implementation PR is not merged yet:
git switch feat/instagram-messaging-spike
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use the generated random value for `WEBHOOK_VERIFY_TOKEN`. Edit `.env` locally:

| Variable | Source |
|---|---|
| `META_APP_SECRET` | Secret of the app signing your Instagram webhooks |
| `META_GRAPH_VERSION` | Supported version selected in Meta dashboard, formatted `vXX.0` |
| `IG_ACCOUNT_ID` | Professional account ID from the authorized Instagram account setup |
| `IG_ACCESS_TOKEN` | Instagram Login user token, never a password |
| `TEST_RECIPIENT_ID` | Fill after the first real inbound message: its `sender_id` |
| `WEBHOOK_VERIFY_TOKEN` | Random value you generated; also enter in Meta webhook settings |

Do not paste tokens or app secrets in chat, issues, screenshots or commits.
`.env` and the SQLite data directory are ignored by Git. On Windows, keep the
project/data folder accessible only to the intended local user. Terminal inbox
output contains private messages. This prototype does not encrypt SQLite at rest.

```powershell
npm test
npm run check
npm run ig -- check
npm start
```

`check` validates the configured account using Graph. It does not prove messaging
permission, webhook delivery, or recipient delivery. `/health` only proves the
HTTP process is running.

## Configure the callback

1. Keep `npm start` running. Start your chosen HTTPS tunnel to `127.0.0.1:3000`.
   Configure the tunnel/reverse proxy to avoid request body and query-string logs.
2. In Meta's Instagram webhook configuration, set the callback to:
   `https://YOUR-PUBLIC-HOST/webhooks/instagram`.
3. Enter the exact `WEBHOOK_VERIFY_TOKEN` value and verify/save the callback.
4. Subscribe to the `messages` webhook field in the dashboard.
5. In another terminal, subscribe the professional account to the app:

```powershell
npm run ig -- subscribe --confirm
```

A dashboard-generated webhook test alone is **not** evidence of a real DM. Fake
sample account IDs are intentionally ignored by this server. Incoming messages
are acknowledged only after the SQLite transaction succeeds; Meta can retry on
failure. Replayed message IDs are stored once.

For hosted use, set `HOST=0.0.0.0` only if needed by the host and use a persistent
volume for `DB_PATH`. Do not expose this over plain HTTP to the internet. Use one
server instance for this prototype; do not put its SQLite file on shared storage.

## Prove the real round trip

1. From the second test account, send Racana a unique DM, for example
   `RACANA-TEST-001`.
2. In the same project directory (same `.env` and `DB_PATH`), run:

```powershell
npm run ig -- inbox
```

3. Confirm the text and timestamp. Copy its `sender_id` into `TEST_RECIPIENT_ID`
   in `.env`; this must be your second test account. Copy its `mid` for the reply.
4. Send exactly one explicit reply:

```powershell
npm run ig -- reply --mid "INBOUND_MESSAGE_ID" --text "Racana test received." --request "racana-test-001" --confirm
npm run ig -- attempts
```

5. Verify the reply actually appears in the second account's Instagram inbox.
   An `accepted` status and returned message ID prove API acceptance only.
6. Restart the backend and confirm `npm run ig -- inbox` still shows the DM.

Reusing the same request ID with identical content returns the existing attempt
without sending again. It is local deduplication, not provider idempotency.
`uncertain` means a timeout/unexpected response may have happened after delivery.
`sending` may remain after a process crash. Inspect Instagram before deciding on
any new request ID. No automatic retry exists. `failed` indicates an explicit
provider rejection. Fix the cause before manually making another attempt.

The prototype conservatively requires an inbound message within 24 hours and
only replies to `TEST_RECIPIENT_ID`; it does not implement policy exceptions.
The provider remains authoritative about whether sending is allowed.

## Evidence checklist

Keep private evidence locally; do not commit message contents or screenshots
containing personal data/tokens to this public repository.

- [ ] `check` identifies the intended Racana account.
- [ ] HTTPS callback verified and messages subscription confirmed.
- [ ] Real inbound DM persisted with account ID, sender ID and message ID.
- [ ] Reply request accepted with an outbound message ID.
- [ ] Reply visually confirmed in the tester's Instagram inbox.
- [ ] Restart preserves the inbound record.

## Troubleshooting

| Symptom | Check |
|---|---|
| Verification 403 | Verify token matches exactly; correct callback path |
| Webhook 401 | Correct app secret and unmodified raw request body |
| Callback verifies but no real messages | `messages` subscription in dashboard AND account subscription; account/tester roles; connected-tool message access in Instagram if required |
| Events arrive but inbox is empty | Correct professional account ID; recipient ID; real `instagram` payload rather than dashboard sample |
| Graph authentication/permission error | Token type, expiry, scopes, app mode and role/access eligibility |
| Reply blocked locally | Tester sender ID and latest inbound timestamp; generate a new DM if outside the reply window |
| Port in use | Change `PORT` and update tunnel target |

## Verification performed

`npm test`: eight automated tests covering signatures, HTTP handshake/ingestion,
replays, account filtering, durable storage, tester-only replies, reply window,
request deduplication, uncertain sends and sanitized Graph errors. Graph requests
are mocked in tests; these do not certify live Meta integration.

`npm run check`: syntax checks for server, core and CLI. GitHub Actions runs both.

## Reference documentation

- [Meta-maintained Instagram API collection](https://www.postman.com/meta/instagram/overview)
- [Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/)
- [Meta webhook setup and signatures](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/)

Next gate: complete the live checklist, then introduce the application foundation
and replace this spike's storage/access model with the planned workspace architecture.
