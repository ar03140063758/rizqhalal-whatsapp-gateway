'use strict';

/**
 * RizqHalal WhatsApp gateway
 * ============================================================================
 *
 * The Next.js app (Vercel) writes a row into `whatsapp_outbox`. This process
 * drains that queue over WhatsApp Web with Baileys:
 *
 *   - one message at a time, 45-60 seconds apart,
 *   - human-like "online -> typing -> pause -> send",
 *   - quiet hours (Pakistan time) and a 5-day warm-up cap,
 *   - STOP is honoured forever, "1" is acknowledged,
 *   - the Baileys session lives in Supabase, so a restart does not need a
 *     new QR scan,
 *   - /health always answers 200 for Render and for the cPanel cron.
 *
 * Run: npm install && npm start
 */

const http = require('node:http');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const {
  default: makeWASocket,
  Browsers,
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  proto,
} = require('@whiskeysockets/baileys');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = Number(process.env.PORT || 10000);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const APP_URL = (process.env.APP_URL || 'https://rizqhalal.site').replace(
  /\/$/,
  '',
);
const CRON_SECRET = process.env.CRON_SECRET || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '[gateway] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.',
  );
  process.exit(1);
}

const logger = pino({ level: LOG_LEVEL });
const waLogger = pino({ level: 'warn' });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* ---------------------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------------------- */

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const WARMUP_CAPS = [15, 20, 25, 30, 40];
const MAX_ATTEMPTS = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 6) return 'unknown';
  return `${d.slice(0, 4)}•••${d.slice(-2)}`;
}

function log(...args) {
  console.log(new Date().toISOString(), '[gateway]', ...args);
}

/** Midnight in Pakistan (UTC+5, no daylight saving), as an ISO string. */
function pakistanDayStart() {
  const pkt = new Date(Date.now() + PKT_OFFSET_MS);
  const startUtcMs =
    Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate()) -
    PKT_OFFSET_MS;
  return new Date(startUtcMs).toISOString();
}

function pakistanHour() {
  return new Date(Date.now() + PKT_OFFSET_MS).getUTCHours();
}

function isQuiet(config) {
  const from = Number(config.quiet_from_hour ?? 21);
  const to = Number(config.quiet_to_hour ?? 9);
  if (from === to) return false;
  const hour = pakistanHour();
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

/** Split a long text into chat-sized bubbles, at a sentence boundary. */
function splitMessage(text, max = 1100) {
  const clean = String(text || '').trim();
  if (clean.length <= max) return [clean];

  const parts = [];
  let rest = clean;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.45) cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.45) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.45) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/* ---------------------------------------------------------------------------
   Supabase state
   --------------------------------------------------------------------------- */

let connected = false;
let connecting = false;
let stopping = false;
let sock = null;
let mePhone = null;
let generation = 0;
let reconnectTimer = null;
let nextSendAt = 0;
let ticking = false;
let authFlush = null;
let localQr = null;
let lastConnectionError = null;
let typingEnabled = true;
let lastRecovery = 0;
let lastCapWarnDay = 0;

async function getConfig() {
  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) {
    logger.error({ err: error.message }, 'could not read whatsapp_config');
    return null;
  }
  return data;
}

async function getSession() {
  const { data } = await supabase
    .from('whatsapp_session')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  return data;
}

async function setSession(patch) {
  const { error } = await supabase
    .from('whatsapp_session')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) logger.error({ err: error.message }, 'could not write session');
}

async function updateOutbox(id, patch) {
  const { error } = await supabase
    .from('whatsapp_outbox')
    .update(patch)
    .eq('id', id);
  if (error) logger.error({ err: error.message }, 'could not update outbox');
}

/* ---------------------------------------------------------------------------
   Baileys auth state in Supabase

   The official helper writes JSON files, but Render wipes the disk on every
   deploy. The credentials and signal keys therefore live in `whatsapp_auth`
   (one row). Buffers are encoded with Baileys' BufferJSON.
   --------------------------------------------------------------------------- */

function encodeJson(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function decodeJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

async function createAuthState() {
  const { data, error } = await supabase
    .from('whatsapp_auth')
    .select('creds, keys')
    .eq('id', 1)
    .maybeSingle();

  if (error) logger.error({ err: error.message }, 'could not read auth state');

  let creds = null;
  let keyStore = {};

  if (data?.creds) {
    try {
      creds = decodeJson(data.creds);
    } catch (err) {
      logger.error({ err: err.message }, 'could not decode creds');
    }
  }
  if (data?.keys) {
    try {
      keyStore = decodeJson(data.keys) || {};
    } catch (err) {
      logger.error({ err: err.message }, 'could not decode keys');
    }
  }

  if (!creds) {
    creds = initAuthCreds();
    log('new WhatsApp credentials generated - a QR scan is needed');
  }

  let timer = null;
  let saving = null;
  let dirty = false;

  async function persist() {
    if (saving) {
      dirty = true;
      return saving;
    }
    dirty = false;
    saving = (async () => {
      const { error: writeError } = await supabase
        .from('whatsapp_auth')
        .upsert(
          {
            id: 1,
            creds: encodeJson(creds),
            keys: encodeJson(keyStore),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' },
        );
      if (writeError) {
        logger.error({ err: writeError.message }, 'could not save auth state');
      }
      saving = null;
      if (dirty) await persist();
    })();
    return saving;
  }

  function schedulePersist() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      persist().catch((err) =>
        logger.error({ err: err.message }, 'auth persist failed'),
      );
    }, 1500);
  }

  const keys = {
    async get(type, ids) {
      const result = {};
      for (const id of ids) {
        let value = keyStore[type]?.[id];
        if (value === undefined) continue;
        if (type === 'app-state-sync-key' && value) {
          try {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          } catch {
            /* keep the raw value */
          }
        }
        result[id] = value;
      }
      return result;
    },
    async set(values) {
      for (const type of Object.keys(values || {})) {
        keyStore[type] = keyStore[type] || {};
        for (const id of Object.keys(values[type] || {})) {
          const value = values[type][id];
          if (value === null || value === undefined) {
            delete keyStore[type][id];
          } else {
            keyStore[type][id] = value;
          }
        }
      }
      schedulePersist();
    },
    async clear() {
      keyStore = {};
      schedulePersist();
    },
  };

  authFlush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await persist();
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await persist();
    },
    clear: async () => {
      if (timer) clearTimeout(timer);
      keyStore = {};
      await supabase.from('whatsapp_auth').delete().eq('id', 1);
      await supabase.from('whatsapp_auth').insert({ id: 1, keys: {} });
      log('auth state cleared');
    },
  };
}

/* ---------------------------------------------------------------------------
   WhatsApp connection
   --------------------------------------------------------------------------- */

function scheduleReconnect(ms = 5000) {
  if (stopping) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) =>
      logger.error({ err: err.message }, 'reconnect failed'),
    );
  }, ms);
  log(`reconnecting in ${Math.round(ms / 1000)}s`);
}

async function handleAdminLogoutRequest() {
  const session = await getSession();
  if (session?.status !== 'logout_requested') return;

  log('admin asked for a disconnect - logging out');
  generation += 1; /* ignore the close event from the old socket */
  try {
    if (sock) await sock.logout();
  } catch (err) {
    logger.warn({ err: err.message }, 'logout call failed');
  }
  try {
    await sock?.end?.();
  } catch {
    /* ignore */
  }
  sock = null;
  connected = false;
  mePhone = null;
  localQr = null;
  await supabase.from('whatsapp_auth').delete().eq('id', 1);
  await supabase.from('whatsapp_auth').insert({ id: 1, keys: {} });
  await supabase
    .from('whatsapp_config')
    .update({ warmup_started_at: null })
    .eq('id', 1);
  await setSession({ status: 'offline', qr: null, phone: null });
  scheduleReconnect(2000);
}

async function connect() {
  if (connecting || stopping) return;
  connecting = true;
  const myGeneration = ++generation;

  try {
    const { state, saveCreds, clear } = await createAuthState();

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
      logger.warn({ err: err.message }, 'could not fetch the WA version');
    }

    const connection = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: waLogger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      markOnline: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000,
      defaultQueryTimeoutMs: 60_000,
      getMessage: async () => undefined,
    });

    sock = connection;

    connection.ev.on('creds.update', saveCreds);

    connection.ev.on('connection.update', async (update) => {
      if (myGeneration !== generation) return;
      const { connection: status, lastDisconnect, qr } = update;

      if (qr) {
        localQr = qr;
        lastConnectionError = null;
        await setSession({ status: 'waiting_qr', qr, phone: null });
        log('QR ready - scan it from /v2/admin/whatsapp');
      }

      if (status === 'open') {
        connected = true;
        localQr = null;
        lastConnectionError = null;
        const rawId = connection.user?.id || '';
        mePhone = rawId.split(':')[0].split('@')[0] || null;
        nextSendAt = 0;

        await setSession({
          status: 'connected',
          qr: null,
          phone: mePhone,
          connected_at: new Date().toISOString(),
          last_seen: new Date().toISOString(),
        });

        const config = await getConfig();
        if (config && !config.warmup_started_at) {
          await supabase
            .from('whatsapp_config')
            .update({ warmup_started_at: new Date().toISOString() })
            .eq('id', 1);
          log('warm-up day 1 starts now');
        }

        log(`connected as ${maskPhone(mePhone)}`);
        return;
      }

      if (status === 'close') {
        connected = false;
        mePhone = null;
        sock = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.statusCode;
        lastConnectionError =
          lastDisconnect?.error?.message || `closed (${statusCode ?? '?'})`;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        log(
          `connection closed (${statusCode ?? 'unknown'})${loggedOut ? ' - logged out' : ''}`,
        );

        if (loggedOut) {
          await clear().catch(() => {});
          await supabase
            .from('whatsapp_config')
            .update({ warmup_started_at: null })
            .eq('id', 1);
          await setSession({
            status: 'logged_out',
            qr: null,
            phone: null,
          });
          scheduleReconnect(3000);
        } else {
          await setSession({ status: 'reconnecting', qr: null });
          scheduleReconnect(statusCode === 515 ? 1000 : 5000);
        }
      }
    });

    connection.ev.on('messages.upsert', async (event) => {
      if (event.type !== 'notify') return;
      for (const msg of event.messages || []) {
        await handleIncoming(msg).catch((err) =>
          logger.error({ err: err.message }, 'incoming message failed'),
        );
      }
    });

    log('socket created');
  } catch (err) {
    logger.error({ err: err.stack || err.message }, 'connect failed');
    scheduleReconnect(10_000);
  } finally {
    connecting = false;
  }
}

/* ---------------------------------------------------------------------------
   Incoming replies: STOP / 1
   --------------------------------------------------------------------------- */

async function handleIncoming(msg) {
  if (!msg?.message || msg.key?.fromMe) return;
  const jid = msg.key?.remoteJid || '';
  if (!jid.endsWith('@s.whatsapp.net')) return;

  const phone = jid.split('@')[0].replace(/\D/g, '');
  const text = extractText(msg.message).trim();
  if (!phone || !text) return;

  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const intent = normalized === 'stop'
    ? 'STOP'
    : ['1', 'confirm', 'confirmed', 'haan', 'yes', 'ok'].includes(normalized)
      ? 'CONFIRM'
      : 'other';

  await supabase.from('whatsapp_inbox').insert({
    from_phone: phone,
    from_name: msg.pushName || null,
    body: text.slice(0, 2000),
    intent,
  });

  try {
    await sock?.readMessages?.([msg.key]);
  } catch {
    /* read receipts are optional */
  }

  if (intent === 'STOP') {
    await supabase
      .from('whatsapp_optout')
      .upsert(
        { phone, reason: 'Replied STOP on WhatsApp' },
        { onConflict: 'phone' },
      );
    await replyShort(
      jid,
      'Theek hai, aap ka number list se hata diya gaya hai. Aapko RizqHalal ki taraf se mazeed message nahi aayega.',
    );
    log(`STOP from ${maskPhone(phone)} - opted out`);
    return;
  }

  if (intent === 'CONFIRM') {
    await supabase
      .from('whatsapp_inbox')
      .update({ handled: true })
      .eq('from_phone', phone)
      .eq('intent', 'CONFIRM')
      .eq('handled', false);
    await replyShort(
      jid,
      'Shukriya! Aap ki confirmation mil gayi. RizqHalal team.',
    );
    log(`confirmation from ${maskPhone(phone)}`);
    return;
  }
}

async function replyShort(jid, text) {
  if (!sock || !connected) return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(rand(900, 1800));
    await sock.sendMessage(jid, { text });
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    logger.warn({ err: err.message }, 'auto-reply failed');
  }
}

/* ---------------------------------------------------------------------------
   The queue loop
   --------------------------------------------------------------------------- */

async function sentTodayCount() {
  const { count } = await supabase
    .from('whatsapp_outbox')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'sent')
    .gte('sent_at', pakistanDayStart());
  return count || 0;
}

function warmupState(config, today) {
  if (!config.warmup_started_at || Number(config.warmup_days) <= 0) {
    return { active: false, day: 0, cap: Number(config.daily_cap || 100) };
  }
  const started = new Date(config.warmup_started_at).getTime();
  const day = Math.floor((Date.now() - started) / 86_400_000) + 1;
  if (day > Number(config.warmup_days)) {
    return { active: false, day, cap: Number(config.daily_cap || 100) };
  }
  const cap =
    WARMUP_CAPS[Math.min(Math.max(day - 1, 0), WARMUP_CAPS.length - 1)];
  return { active: true, day, cap };
}

async function sendOne(row) {
  const jid = `${String(row.to_phone).replace(/\D/g, '')}@s.whatsapp.net`;

  const { data: optout } = await supabase
    .from('whatsapp_optout')
    .select('phone')
    .eq('phone', row.to_phone)
    .maybeSingle();

  if (optout) {
    await updateOutbox(row.id, {
      status: 'cancelled',
      error: 'The number replied STOP',
    });
    log(`skipped ${maskPhone(row.to_phone)} - opted out`);
    return;
  }

  let exists = true;
  try {
    const result = await sock.onWhatsApp(jid);
    const found = Array.isArray(result) ? result[0] : result;
    if (found && found.exists === false) exists = false;
  } catch (err) {
    logger.warn({ err: err.message }, 'onWhatsApp check failed');
  }

  if (!exists) {
    await updateOutbox(row.id, {
      status: 'failed',
      error: 'This number is not on WhatsApp',
    });
    log(`failed ${maskPhone(row.to_phone)} - not on WhatsApp`);
    return;
  }

  const text =
    row.message ||
    `${row.body}\n\nConfirm karne ke liye 1 reply karein. Band karne ke liye STOP likhein.`;

  try {
    if (typingEnabled) {
      await sock.sendPresenceUpdate('available', jid);
      await sleep(rand(600, 1600));
      await sock.sendPresenceUpdate('composing', jid);
      await sleep(Math.min(9000, Math.max(1800, text.length * 45 + rand(0, 1200))));
      if (Math.random() < 0.15) {
        await sock.sendPresenceUpdate('paused', jid);
        await sleep(rand(900, 2400));
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(rand(600, 1600));
      }
    }

    const bubbles = splitMessage(text);
    let firstId = null;

    for (let i = 0; i < bubbles.length; i += 1) {
      if (i > 0) {
        await sleep(rand(1800, 4200));
        if (typingEnabled) {
          await sock.sendPresenceUpdate('composing', jid);
          await sleep(rand(900, 2000));
        }
      }
      const sent = await sock.sendMessage(jid, { text: bubbles[i] });
      if (i === 0) firstId = sent?.key?.id || null;
    }

    if (typingEnabled) {
      await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }

    await updateOutbox(row.id, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      wa_message_id: firstId,
      error: null,
    });
    log(`sent to ${maskPhone(row.to_phone)}: ${String(row.title).slice(0, 60)}`);
  } catch (err) {
    const message = String(err?.message || err).slice(0, 500);
    const attempts = Number(row.attempts || 1);

    if (attempts < MAX_ATTEMPTS) {
      const backoffMin = [5, 15, 45][Math.min(attempts - 1, 2)];
      await updateOutbox(row.id, {
        status: 'queued',
        error: message,
        scheduled_at: new Date(
          Date.now() + backoffMin * 60_000,
        ).toISOString(),
      });
      log(
        `send failed (attempt ${attempts}) - retry in ${backoffMin}m: ${message}`,
      );
    } else {
      await updateOutbox(row.id, { status: 'failed', error: message });
      log(`gave up on ${maskPhone(row.to_phone)}: ${message}`);
    }
  }
}

async function tick() {
  if (ticking || stopping) return;
  ticking = true;

  try {
    await handleAdminLogoutRequest();
    await recoverStuck();

    if (!connected || !sock) return;

    const config = await getConfig();
    if (!config?.enabled) return;

    typingEnabled = Boolean(config.typing_simulation);

    if (isQuiet(config)) return;
    if (Date.now() < nextSendAt) return;

    const today = await sentTodayCount();
    const warm = warmupState(config, today);
    const cap = warm.active ? warm.cap : Number(config.daily_cap || 100);

    if (today >= cap) {
      if (lastCapWarnDay !== today) {
        lastCapWarnDay = today;
        log(`daily cap reached (${today}/${cap}) - waiting for tomorrow`);
      }
      return;
    }

    const priorityMax = warm.active ? 2 : 3;
    const { data, error } = await supabase.rpc('claim_whatsapp_message', {
      p_priority_max: priorityMax,
    });

    if (error) {
      logger.error({ err: error.message }, 'could not claim a message');
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return;

    await sendOne(row);

    const min = Math.max(10, Number(config.min_delay_sec || 45));
    const max = Math.max(min, Number(config.max_delay_sec || 60));
    nextSendAt = Date.now() + rand(min, max) * 1000;
  } catch (err) {
    logger.error({ err: err.stack || err.message }, 'tick failed');
  } finally {
    ticking = false;
  }
}

/* ---------------------------------------------------------------------------
   Heartbeat + health server
   --------------------------------------------------------------------------- */

async function heartbeat() {
  try {
    await supabase
      .from('whatsapp_session')
      .update({ last_seen: new Date().toISOString() })
      .eq('id', 1);
  } catch (err) {
    logger.warn({ err: err.message }, 'heartbeat failed');
  }
}

/** Put rows claimed by a crashed worker back in the queue. */
async function recoverStuck(force = false) {
  const now = Date.now();
  if (!force && now - lastRecovery < 5 * 60 * 1000) return;
  lastRecovery = now;

  const cutoff = new Date(now - 10 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('whatsapp_outbox')
    .update({
      status: 'queued',
      error: 'Recovered after the worker stopped mid-send',
    })
    .eq('status', 'sending')
    .lt('claimed_at', cutoff);
  if (error) logger.warn({ err: error.message }, 'recovery failed');
}

/**
 * Run the class reminders (5 minutes before, start, no-show) on the site.
 *
 * Vercel's Hobby cron only runs once a day, and the browser bell cannot be
 * trusted to be open. This box is always on, so it pings the API every
 * minute with the shared secret.
 */
async function runLifecycle() {
  if (!CRON_SECRET) return;
  try {
    const res = await fetch(`${APP_URL}/api/class-lifecycle`, {
      headers: { 'x-cron-secret': CRON_SECRET },
      cache: 'no-store',
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'class lifecycle ping failed');
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data?.reminders || data?.noShows) {
      log(
        `class lifecycle: ${data.reminders ?? 0} reminder(s), ${data.noShows ?? 0} no-show(s)`,
      );
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'class lifecycle ping failed');
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/health')) {
    let queue = null;
    try {
      const { count } = await supabase
        .from('whatsapp_outbox')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'queued');
      queue = count ?? 0;
    } catch {
      /* the DB may be waking up; still answer 200 for Render */
    }

    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'rizqhalal-whatsapp-gateway',
        whatsapp: connected ? 'connected' : 'offline',
        phone: mePhone ? maskPhone(mePhone) : null,
        queue,
        last_error: lastConnectionError,
        uptime_seconds: Math.round(process.uptime()),
        time: new Date().toISOString(),
      }),
    );
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('RizqHalal WhatsApp gateway\n');
});

/* ---------------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------------- */

async function main() {
  server.listen(PORT, '0.0.0.0', () => {
    log(`health server on 0.0.0.0:${PORT}/health`);
  });

  /* Any message stuck in "sending" from a previous crash goes back in. */
  await recoverStuck(true);

  /* The row may predate this deploy - never overwrite a live status. */
  const { data: existingSession } = await supabase
    .from('whatsapp_session')
    .select('id')
    .eq('id', 1)
    .maybeSingle();
  if (!existingSession) {
    await supabase
      .from('whatsapp_session')
      .insert({ id: 1, status: 'offline' });
  }

  await connect();

  setInterval(() => {
    heartbeat().catch(() => {});
  }, 30_000);
  heartbeat().catch(() => {});

  setInterval(() => {
    tick().catch(() => {});
  }, 8000);

  /* Reminders and no-show handling - the gateway is the always-on cron. */
  runLifecycle();
  setInterval(() => {
    runLifecycle();
  }, 60_000);

  log('gateway started');
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received - shutting down`);

  try {
    await authFlush?.();
  } catch {
    /* ignore */
  }
  try {
    await sock?.end?.();
  } catch {
    /* ignore */
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: String(reason) }, 'unhandled rejection');
});

main().catch((err) => {
  logger.fatal({ err: err.stack || err.message }, 'gateway failed to start');
  process.exit(1);
});
