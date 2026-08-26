# Star Forge — Vercel deployment (no card required)

This is the same game, restructured to run on Vercel's free Hobby tier,
which needs no credit card. The tradeoff: instead of one server that stays
running, Vercel spins up your code fresh for each request. That changes
two things you should know about:

1. **No `app.listen()`** — `api/index.js` exports the Express app, and
   Vercel handles running it per-request.
2. **In-memory storage is unreliable here.** The `userBalances` Map in
   `api/index.js` may reset between requests, since there's no single
   long-running process holding it in memory. Fine for testing the
   Stars payment flow end to end. **Before real players use this, swap it
   for a real datastore** — Upstash Redis or Vercel KV both have free
   tiers with no card and are simple to wire in (ask me when you're ready
   for that step).

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
- `SETUP_SECRET` — make up any random string yourself (e.g. a long
  password). This protects the one-time webhook setup endpoint so a
  stranger can't hijack your bot's webhook.

Then **Deployments → \[latest] → Redeploy** so the new env vars take effect.

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
