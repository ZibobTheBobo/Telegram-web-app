const express = require('express');
const crypto = require('crypto');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SETUP_SECRET = process.env.SETUP_SECRET; // any random string you choose

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var — set it in Vercel Project Settings > Environment Variables');
}

const bot = new Telegraf(BOT_TOKEN || 'missing-token');
const app = express();
app.use(express.json());

// --- In-memory "database" — DEMO ONLY. ---
// IMPORTANT: on Vercel this resets unpredictably between requests, because
// serverless functions don't keep a single process running the way a
// normal server does. This is fine for testing the payment flow end to
// end, but before real players use this you need a real datastore (e.g.
// Upstash Redis or Vercel KV — both have free tiers with no card).
const userBalances = new Map();
const grantedPurchases = new Map();

function getBalance(userId) {
  return userBalances.get(userId) || 0;
}
function addCoins(userId, amount) {
  userBalances.set(userId, getBalance(userId) + amount);
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

app.post('/api/me', (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'Invalid Telegram auth' });
  res.json({ userId: user.id, balance: getBalance(user.id) });
});

app.post('/api/tap', (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'Invalid Telegram auth' });
  addCoins(user.id, 1);
  res.json({ balance: getBalance(user.id) });
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

bot.on('message', async (ctx) => {
  const payment = ctx.message.successful_payment;
  if (!payment) return;

  const { userId, itemId } = JSON.parse(payment.invoice_payload);
  const item = SHOP_ITEMS[itemId];
  if (item) {
    if (item.grantCoins) addCoins(userId, item.grantCoins);
    const owned = grantedPurchases.get(userId) || new Set();
    owned.add(itemId);
    grantedPurchases.set(userId, owned);
  }
  console.log(`Payment received: user ${userId} bought ${itemId}, charge_id=${payment.telegram_payment_charge_id}`);
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

module.exports = app;
