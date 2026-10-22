# RizqHalal WhatsApp gateway

The always-on sender behind `/v2/admin/whatsapp`. The Next.js app on Vercel
writes rows into `whatsapp_outbox`; this process drains them over WhatsApp Web
with [Baileys](https://github.com/WhiskeySockets/Baileys).

## What it does

- Links the WhatsApp number once via the QR shown in the admin panel.
- Saves the Baileys credentials and signal keys in Supabase (`whatsapp_auth`),
  so a Render restart or redeploy **does not need a new scan**.
- Claims one message at a time with `claim_whatsapp_message()` (atomic,
  `FOR UPDATE SKIP LOCKED`).
- Human-like sending: online → typing → pause → send, with a random 45-60 s
  gap between messages.
- 5-day warm-up: day 1-5 caps at 15 / 20 / 25 / 30 / 40 messages and only
  priority 1-2 (payments, reminders, approvals) go out.
- Quiet hours 21:00-09:00 Pakistan time by default.
- Honours `STOP` forever, acknowledges `1`.
- `/health` always answers `200` for Render's health check and the cPanel cron.
- Retries a failed send 3 times with backoff, then marks it `failed`.

## Environment

| Key | Value |
| --- | --- |
| `SUPABASE_URL` | `https://hsenqodyczbjetazzdgx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role key (never the anon key) |
| `PORT` | Render sets this automatically |
| `LOG_LEVEL` | `info` (or `warn` in production) |

## Run locally

```bash
npm install
copy .env.example .env      # then fill the two Supabase values
npm start
```

Open `http://localhost:10000/health`. The QR appears in
`/v2/admin/whatsapp`, not in the terminal.

## Deploy on Render

1. Push this folder to a **public** GitHub repository
   (`rizqhalal-whatsapp-gateway`).
2. Render → New → Web Service → connect the repository.
3. Runtime **Node**, plan **Free**, region **Singapore**.
4. Build command: `npm install --no-audit --no-fund`
   Start command: `node index.js`
   Health check path: `/health`
5. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
6. Deploy, then open `/v2/admin/whatsapp`, scan the QR with the phone that
   will send the messages.

The `render.yaml` in this folder does the same thing as a Blueprint.

## Keep it awake (free plan)

Render sleeps a free service after 15 minutes without **inbound** HTTP
traffic. Point a cron at the health URL every 5 minutes:

```cron
*/5 * * * * curl -s -o /dev/null https://rizqhalal-whatsapp-gateway.onrender.com/health
```

UptimeRobot or cron-job.org (every 5 minutes) do the same job. Do **not** use a
14-second loop on a shared cPanel host - it looks like abuse and can get the
account suspended. Outbound WhatsApp messages do not count as Render traffic,
so a "heartbeat message" every 14 minutes does not keep the box awake.

## Health response

```json
{
  "ok": true,
  "whatsapp": "connected",
  "phone": "9230•••67",
  "queue": 0,
  "uptime_seconds": 3600
}
```

## Notes

- Only one gateway may run at a time. The atomic claim prevents double sends,
  but two sockets on the same number fight over the session.
- Re-linking the number too often looks suspicious to WhatsApp. Keep
  `relink_after_days` at 0 unless the session is actually lost.
- This uses WhatsApp Web (unofficial). A number that spams strangers gets
  banned; the warm-up, quiet hours and caps exist to avoid that.
