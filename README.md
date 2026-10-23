# RizqHalal WhatsApp gateway

The always-on sender behind `/v2/admin/whatsapp`. The Next.js app on Vercel
writes rows into `whatsapp_outbox`; this process drains them over WhatsApp Web
with [Baileys](https://github.com/WhiskeySockets/Baileys).

## What it does

- Links the WhatsApp number once via the QR shown in the admin panel.
- Saves the Baileys credentials and signal keys in Supabase (`whatsapp_auth`),
  so a restart or redeploy **does not need a new scan**.
- Claims one message at a time with `claim_whatsapp_message()` (atomic,
  `FOR UPDATE SKIP LOCKED`).
- Human-like sending: online -> typing -> pause -> send, with a random 45-60 s
  gap between messages.
- 5-day warm-up: day 1-5 caps at 15 / 20 / 25 / 30 / 40 messages and only
  priority 1-2 (payments, reminders, approvals) go out.
- Quiet hours 21:00-09:00 Pakistan time by default.
- Honours `STOP` forever, acknowledges `1`.
- `/health` always answers `200` for uptime checks.
- Pings `/api/class-lifecycle` on the website every minute when `APP_URL` and
  `CRON_SECRET` are set (Vercel Hobby cron only runs once a day).
- Retries a failed send 3 times with backoff, then marks it `failed`.

## Environment

| Key | Value |
| --- | --- |
| `SUPABASE_URL` | `https://hsenqodyczbjetazzdgx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role key (never the anon key) |
| `APP_URL` | `https://rizqhalal.site` (class-reminder ping) |
| `CRON_SECRET` | the same value as the Vercel project |
| `PORT` | the port the host assigns (local default `10000`; Pterodactyl's `SERVER_PORT` is used when `PORT` is absent) |
| `LOG_LEVEL` | `info` (or `warn` in production) |

The gateway also reads a local `.env` file next to `index.js`. That lets a host
without panel environment variables (Pterodactyl, cPanel, a plain VPS) inject
the secrets by uploading one file. A real environment variable always wins, so
Render/Railway-style hosts can keep using their own settings.

## Run locally

```bash
npm install
copy .env.example .env      # then fill the two Supabase values
npm start
```

Open `http://localhost:10000/health`. The QR appears in
`/v2/admin/whatsapp`, not in the terminal.

## Deploy on Waifly (Pterodactyl, free)

Waifly's free plan is 300 MB RAM / 1 GB disk, runs Node.js 24/7 and needs no
card. Render's free tier now asks for a card, so it is not used.

1. `dash.waifly.com` -> create a **NodeJS** server.
2. Open the server in `panel.waifly.com` and note the allocated port.
3. Upload this folder (without `node_modules` and `.git`) through SFTP or the
   panel File Manager.
4. In the panel console run `npm ci --omit=dev --omit=optional` (or
   `npm install --omit=dev --omit=optional`). The two "install script not run"
   warnings from Baileys/protobufjs are harmless.
5. Create `.env` in the server root with the keys from the table above. Set
   `PORT` to the allocated port if the panel does not inject `SERVER_PORT`.
6. Startup command `node index.js`, main file `index.js`.
7. Start the server and check the console for the gateway log line.
8. Open `https://rizqhalal.site/v2/admin/whatsapp` and scan the QR with the
   phone that will send the messages.

WhatsApp traffic is outbound, so the gateway does not need a public port. If
the panel gives a public URL, set `WHATSAPP_GATEWAY_URL` on Vercel to show the
health URL inside the admin page.

## Scheduled jobs (cron-job.org)

The gateway already pings the class worker every minute, but cron-job.org is
the independent backup and keeps reminders running while the gateway is down.
The free plan allows a 1-minute interval, a 30-second timeout and custom
headers.

**Job 1 - class reminders (required)**

- URL: `https://rizqhalal.site/api/class-lifecycle`
- Method: `GET`
- Schedule: every 1 minute
- Header: `x-cron-secret: <CRON_SECRET>`
- Timeout: 30 seconds
- Expected response: `{"ok":true,"reminders":0,"noShows":0,...}`

**Job 2 - gateway health (optional)**

- URL: `https://<gateway-host>/health`
- Schedule: every 5 minutes
- Only useful when the host exposes a public URL and can sleep; Waifly does
  not sleep, so this is monitoring only.

Creating the job from the command line:

```bash
curl -X PUT https://api.cron-job.org/jobs \
  -H "Authorization: Bearer $CRONJOB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "job": {
      "title": "RizqHalal class reminders",
      "url": "https://rizqhalal.site/api/class-lifecycle",
      "enabled": true,
      "saveResponses": true,
      "requestMethod": 0,
      "schedule": {
        "timezone": "Asia/Karachi",
        "expiresAt": 0,
        "hours": [-1], "mdays": [-1], "minutes": [-1],
        "months": [-1], "wdays": [-1]
      },
      "extendedData": {
        "headers": { "x-cron-secret": "<CRON_SECRET>" },
        "body": ""
      }
    }
  }'
```

`minutes: [-1]` means every minute. Keep the secret out of screenshots and
public repos.

## Health response

```json
{
  "ok": true,
  "whatsapp": "connected",
  "phone": "9230***67",
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
- `Dockerfile` and `render.yaml` are legacy options and are not needed on
  Waifly/Pterodactyl.
