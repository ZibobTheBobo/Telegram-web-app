const express = require('express');
const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const { Redis } = require('@upstash/redis');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SETUP_SECRET = process.env.SETUP_SECRET; // any random string you choose

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var — set it in Vercel Project Settings > Environment Variables');
}

const bot = new Telegraf(BOT_TOKEN || 'missing-token');
const app = express();
app.use(express.json());

// --- Persistent storage via Upstash Redis. ---
// Falls back to an in-memory Map if UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN aren't set yet, so the app still runs before
// you've created a database — but balances will only actually persist
// across requests once those two env vars are set. See README for setup.
const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = hasRedis
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;
if (!hasRedis) {
  console.warn('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — balances will NOT persist. See README.');
}

// In-memory fallback (only used when Redis isn't configured)
const memBalances = new Map();
const memPurchases = new Map();
const memProcessedCharges = new Set();
const memNames = new Map();

async function getBalance(userId) {
  if (redis) {
    const val = await redis.get(`balance:${userId}`);
    return val ? Number(val) : 0;
  }
  return memBalances.get(userId) || 0;
}

async function addCoins(userId, amount) {
  if (redis) {
    return redis.incrby(`balance:${userId}`, amount);
  }
  const next = (memBalances.get(userId) || 0) + amount;
  memBalances.set(userId, next);
  return next;
}

async function recordPurchase(userId, itemId) {
  if (redis) {
    return redis.sadd(`purchases:${userId}`, itemId);
  }
  const owned = memPurchases.get(userId) || new Set();
  owned.add(itemId);
  memPurchases.set(userId, owned);
}

// Prevents double-granting coins if Telegram retries a webhook delivery
// for a payment we already processed.
async function markChargeProcessed(chargeId) {
  if (redis) {
    // sadd returns 1 if newly added, 0 if it was already a member
    const added = await redis.sadd('processed_charges', chargeId);
    return added === 1;
  }
  if (memProcessedCharges.has(chargeId)) return false;
  memProcessedCharges.add(chargeId);
  return true;
}

// --- Charge records: every Stars payment is saved so it can be refunded later. ---
const memCharges = new Map();
const memRefundLocks = new Set();

async function saveCharge(chargeId, record) {
  if (redis) {
    await redis.set(`charge:${chargeId}`, record);
    await redis.zadd('charges_by_time', { score: record.at, member: chargeId });
    return;
  }
  memCharges.set(chargeId, record);
}

async function getCharge(chargeId) {
  if (redis) return (await redis.get(`charge:${chargeId}`)) || null;
  return memCharges.get(chargeId) || null;
}

async function listCharges(limit = 50) {
  if (redis) {
    const ids = await redis.zrange('charges_by_time', 0, limit - 1, { rev: true });
    const records = await Promise.all(ids.map((id) => getCharge(id)));
    return records.filter(Boolean).map((r, i) => ({ chargeId: ids[i], ...r }));
  }
  return [...memCharges.entries()]
    .map(([chargeId, r]) => ({ chargeId, ...r }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

// Returns true only for the first caller, so two refund requests for the
// same charge can never both go through.
async function takeRefundLock(chargeId) {
  if (redis) {
    const ok = await redis.set(`refund_lock:${chargeId}`, '1', { nx: true });
    return ok === 'OK';
  }
  if (memRefundLocks.has(chargeId)) return false;
  memRefundLocks.add(chargeId);
  return true;
}

async function releaseRefundLock(chargeId) {
  if (redis) return redis.del(`refund_lock:${chargeId}`);
  memRefundLocks.delete(chargeId);
}

function displayNameFor(user) {
  if (user.username) return '@' + user.username;
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Player';
}

// Keeps a sorted set (score = balance) for ranking, plus a name lookup so
// the leaderboard can show something readable instead of raw user ids.
async function syncLeaderboard(userId, balance, name) {
  if (redis) {
    await redis.zadd('leaderboard', { score: balance, member: String(userId) });
    if (name) await redis.hset('user_names', { [String(userId)]: name });
    return;
  }
  memBalances.set(userId, balance);
  if (name) memNames.set(userId, name);
}

async function getLeaderboard(limit = 10) {
  if (redis) {
    const raw = await redis.zrange('leaderboard', 0, limit - 1, { rev: true, withScores: true });
    const entries = [];
    for (let i = 0; i < raw.length; i += 2) {
      entries.push({ userId: raw[i], score: Number(raw[i + 1]) });
    }
    if (!entries.length) return [];
    const names = await redis.hmget('user_names', ...entries.map((e) => e.userId));
    return entries.map((e) => ({ ...e, name: (names && names[e.userId]) || 'Player' }));
  }
  return [...memBalances.entries()]
    .map(([userId, score]) => ({ userId, score, name: memNames.get(userId) || 'Player' }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

const SHOP_ITEMS = {
  coin_pack_small: { title: '500 Coins', description: 'A small pile of coins', amount: 25, grantCoins: 500 },
  coin_pack_large: { title: '3000 Coins', description: 'A big pile of coins', amount: 100, grantCoins: 3000 },
  double_tap_boost: { title: 'Double Tap Boost (1h)', description: 'Doubles coins per tap for 1 hour', amount: 50, grantCoins: 0 },
};

// --- Validate Telegram WebApp initData so you know a request really came
// from Telegram and which user it belongs to. ---
function validateInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return null;
    return JSON.parse(params.get('user'));
  } catch (e) {
    return null;
  }
}

app.post('/api/me', async (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'Invalid Telegram auth' });
  const balance = await getBalance(user.id);
  await syncLeaderboard(user.id, balance, displayNameFor(user));
  res.json({ userId: user.id, balance });
});

app.post('/api/tap', async (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'Invalid Telegram auth' });
  const balance = await addCoins(user.id, 1);
  await syncLeaderboard(user.id, balance ?? (await getBalance(user.id)), displayNameFor(user));
  res.json({ balance: await getBalance(user.id) });
});

app.get('/api/leaderboard', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  res.json({ leaderboard: await getLeaderboard(limit) });
});

app.post('/api/create-invoice', async (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'Invalid Telegram auth' });

  const { itemId } = req.body;
  const item = SHOP_ITEMS[itemId];
  if (!item) return res.status(400).json({ error: 'Unknown item' });

  try {
    const link = await bot.telegram.createInvoiceLink({
      title: item.title,
      description: item.description,
      payload: JSON.stringify({ userId: user.id, itemId }),
      provider_token: '', // empty string is required for Stars payments
      currency: 'XTR',
      prices: [{ label: item.title, amount: item.amount }],
    });
    res.json({ invoiceLink: link });
  } catch (err) {
    console.error('createInvoiceLink failed:', err);
    res.status(500).json({ error: 'Could not create invoice' });
  }
});

// --- Telegram webhook: payment events land here ---
bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

// Telegram requires bots that accept Stars to answer /paysupport (and
// /terms). Set SUPPORT_CONTACT in Vercel to your Telegram username, e.g. @yourname.
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || 'the bot owner';

bot.command('paysupport', (ctx) =>
  ctx.reply(
    `Need help with a purchase or want a refund? Contact ${SUPPORT_CONTACT} and include your Telegram username and what you bought. ` +
    `Refunded purchases are returned as Telegram Stars and the coins from that purchase are removed.`
  )
);

bot.command('terms', (ctx) =>
  ctx.reply(
    'Star Forge sells in-game coins and boosts for Telegram Stars. Purchases are digital and have no cash value. ' +
    `For problems with a purchase, use /paysupport or contact ${SUPPORT_CONTACT}.`
  )
);

bot.on('message', async (ctx) => {
  const payment = ctx.message.successful_payment;
  if (!payment) return;

  const chargeId = payment.telegram_payment_charge_id;
  const isNew = await markChargeProcessed(chargeId);
  if (!isNew) {
    console.log(`Duplicate webhook for charge_id=${chargeId}, skipping — already granted.`);
    return;
  }

  const { userId, itemId } = JSON.parse(payment.invoice_payload);
  const item = SHOP_ITEMS[itemId];
  if (item) {
    let balance;
    if (item.grantCoins) balance = await addCoins(userId, item.grantCoins);
    else balance = await getBalance(userId);
    await recordPurchase(userId, itemId);
    await syncLeaderboard(userId, balance, displayNameFor(ctx.from));
    await saveCharge(chargeId, {
      userId,
      name: displayNameFor(ctx.from),
      itemId,
      stars: payment.total_amount,
      coins: item.grantCoins || 0,
      at: Date.now(),
      refunded: false,
    });
  }
  console.log(`Payment received: user ${userId} bought ${itemId}, charge_id=${chargeId}`);
});

// Verify requests on this path really came from Telegram via the secret
// token we register in /api/setup-webhook below.
app.use('/api/telegram-webhook', bot.webhookCallback('/', {
  secretToken: SETUP_SECRET,
}));

// --- One-time setup: visit this URL once after deploying to register the
// webhook with Telegram. Protected by SETUP_SECRET so randoms can't hijack
// your bot's webhook. ---
app.get('/api/setup-webhook', async (req, res) => {
  if (!SETUP_SECRET || req.query.secret !== SETUP_SECRET) {
    return res.status(403).json({ error: 'Missing or wrong ?secret=' });
  }
  const publicUrl = process.env.PUBLIC_URL || `https://${req.headers.host}`;
  try {
    await bot.telegram.setWebhook(`${publicUrl}/api/telegram-webhook`, {
      secret_token: SETUP_SECRET,
    });
    res.json({ ok: true, webhook: `${publicUrl}/api/telegram-webhook` });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Owner-only endpoints (protected by SETUP_SECRET) ---
function adminOk(req) {
  if (!SETUP_SECRET) return false;
  const given = Buffer.from(String(req.query.secret || req.headers['x-admin-secret'] || ''));
  const expected = Buffer.from(SETUP_SECRET);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// List recent purchases with their charge ids:
//   /api/charges?secret=YOUR_SECRET
app.get('/api/charges', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'Missing or wrong ?secret=' });
  res.json({ charges: await listCharges(Math.min(Number(req.query.limit) || 50, 200)) });
});

// Refund one purchase: gives the Stars back and removes that purchase's coins.
//   /api/refund?secret=YOUR_SECRET&charge_id=THE_CHARGE_ID
// For purchases made before charges were saved, add &user_id=BUYER_ID too;
// the Stars are refunded but no coins can be removed automatically.
app.get('/api/refund', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'Missing or wrong ?secret=' });

  const chargeId = String(req.query.charge_id || '');
  if (!chargeId) return res.status(400).json({ error: 'charge_id is required' });

  const record = await getCharge(chargeId);
  const userId = record ? record.userId : Number(req.query.user_id);
  if (!userId) {
    return res.status(404).json({ error: 'Charge not found. If it is an older purchase, add &user_id=BUYER_ID' });
  }
  if (record && record.refunded) return res.status(409).json({ error: 'Already refunded' });

  if (!(await takeRefundLock(chargeId))) {
    return res.status(409).json({ error: 'A refund for this charge is already in progress or done' });
  }

  try {
    await bot.telegram.callApi('refundStarPayment', {
      user_id: userId,
      telegram_payment_charge_id: chargeId,
    });
  } catch (err) {
    await releaseRefundLock(chargeId); // Telegram said no, so allow a retry
    return res.status(502).json({ error: 'Telegram refused the refund', detail: String(err.description || err) });
  }

  // Stars are back with the buyer. Now take the coins back (never below zero).
  let coinsRemoved = 0;
  let newBalance = null;
  if (record) {
    const balance = await getBalance(userId);
    coinsRemoved = Math.min(record.coins || 0, balance);
    if (coinsRemoved > 0) newBalance = await addCoins(userId, -coinsRemoved);
    else newBalance = balance;
    await syncLeaderboard(userId, newBalance ?? (await getBalance(userId)), record.name);
    await saveCharge(chargeId, { ...record, refunded: true, refundedAt: Date.now() });
  }

  console.log(`Refunded charge_id=${chargeId} user=${userId} coinsRemoved=${coinsRemoved}`);
  res.json({ ok: true, chargeId, userId, starsRefunded: record ? record.stars : undefined, coinsRemoved });
});

module.exports = app;
