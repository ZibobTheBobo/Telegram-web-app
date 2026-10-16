# Star Forge — Vercel deployment (no card required)

This is the same game, restructured to run on Vercel's free Hobby tier,
which needs no credit card. The tradeoff: instead of one server that stays
running, Vercel spins up your code fresh for each request. That changes
two things you should know about:

1. **No `app.listen()`** — `api/index.js` exports the Express app, and
   Vercel handles running it per-request.
2. **Balances persist via Upstash Redis.** Set up in step 3a below — takes
   about 2 minutes, no card required. Until you add the two Redis env
   vars, the app still runs using an in-memory fallback, but balances will
   reset unpredictably (that's the old behavior). Once Redis is
   configured, balances persist properly across refreshes and redeploys.

## 1. Push this project to GitHub

Same as before — if you already have the old project on GitHub, you can
either replace its contents with this folder or make a new repo. From
this folder:

```
git init
git add .
git commit -m "Vercel version"
```

Then create a repo on GitHub and follow its instructions to push.

## 2. Import into Vercel

1. Go to vercel.com, sign up with GitHub (no card needed for Hobby plan).
2. **Add New → Project**, select your repo, click **Deploy**. Vercel
   auto-detects Node and the `api/` folder — you don't need to set a
   build or start command.
3. It'll fail on the first deploy because environment variables aren't
   set yet — that's expected, fix it in the next step.

## 3. Set environment variables

In your Vercel project: **Settings → Environment Variables**, add:

- `BOT_TOKEN` — your bot's token from BotFather
- `SETUP_SECRET` — make up any random string yourself (letters, numbers,
  underscores, hyphens only). This protects the one-time webhook setup
  endpoint so a stranger can't hijack your bot's webhook.

Then **Deployments → \[latest] → Redeploy** so the new env vars take effect.

### 3a. Set up persistent storage (Upstash Redis)

Without this, balances reset unpredictably between requests — this is the
step that fixes that.

1. Go to [upstash.com](https://upstash.com), sign up (GitHub login works,
   no card needed).
2. **Create Database** → give it any name → choose a region close to you
   → Create.
3. On the database's page, find **REST API** section — copy the
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` values shown
   there.
4. Back in Vercel: **Settings → Environment Variables**, add both as new
   variables with those exact names and the values you copied.
5. **Deployments → \[latest] → Redeploy** so the app picks them up.

That's it — no schema or setup needed, the app creates its keys
automatically the first time someone taps or buys something. Balances
will now survive refreshes, redeploys, and cold starts.

## 4. Register the webhook (one-time step)

Vercel gives you a URL like `https://your-project.vercel.app`. Visit this
once in your browser (replacing both placeholders):

```
https://your-project.vercel.app/api/setup-webhook?secret=YOUR_SETUP_SECRET
```

You should see `{"ok":true,"webhook":"https://your-project.vercel.app/api/telegram-webhook"}`.
That's it — you only need to do this once, or again if you ever change
the deployed URL.

## 5. Point BotFather at your app

Same as before: @BotFather → your bot → Bot Settings → Menu Button (or
`/newapp`), set the Web App URL to `https://your-project.vercel.app`.

## 6. Test it

Open your bot in Telegram, launch the Mini App, tap a few times, try a
shop purchase. Because of the in-memory storage caveat above, if your
balance seems to reset unexpectedly between sessions, that's the known
limitation — not a bug in the payment logic itself.

## 7. Refunds and support

Every Stars purchase is now saved (who bought, what, how many Stars, and
the charge id). Only you can use the two owner endpoints below, because
they need your `SETUP_SECRET`. Keep these URLs private.

**See recent purchases and their charge ids**

```
https://your-project.vercel.app/api/charges?secret=YOUR_SETUP_SECRET
```

**Refund one purchase** (copy its `chargeId` from the list above)

```
https://your-project.vercel.app/api/refund?secret=YOUR_SETUP_SECRET&charge_id=THE_CHARGE_ID
```

On success you get `{"ok":true,...,"coinsRemoved":500}`. The buyer gets
their Stars back, and the coins from that purchase are taken off their
balance (never below zero). Each charge can only be refunded once.

**Purchases made before this update** weren't saved. To refund one, find
its charge id in Vercel logs (search "Payment received") and add the
buyer's Telegram user id:

```
.../api/refund?secret=YOUR_SETUP_SECRET&charge_id=THE_CHARGE_ID&user_id=BUYER_USER_ID
```

That refunds the Stars only, since the coin amount isn't known.

**Support commands.** Telegram expects Stars bots to answer `/paysupport`
and `/terms`; both are built in. Add one more Vercel environment variable,
`SUPPORT_CONTACT`, set to your Telegram username (for example `@yourname`)
so buyers know who to contact, then redeploy. Also add them in @BotFather
with `/setcommands`:

```
paysupport - Help with a purchase or refund
terms - Purchase terms
```
