# Discord Feed Bot

A serverless Discord bot that pulls the latest posts from subreddits, blogs and any RSS/Atom feed straight into your server with slash commands. Users can optionally connect their Reddit account to see their personal front page.

![Tests](https://github.com/giorgimskh/discord-feed-bot/actions/workflows/test.yml/badge.svg)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?logo=cloudflare&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES_modules-F7DF1E?logo=javascript&logoColor=black)
![Discord](https://img.shields.io/badge/Discord-HTTP_interactions-5865F2?logo=discord&logoColor=white)
![Reddit](https://img.shields.io/badge/Reddit-OAuth_2.0-FF4500?logo=reddit&logoColor=white)

![Architecture diagram](docs/architecture.svg)

## Features

- **Fully serverless.** Runs on Cloudflare Workers via Discord HTTP interactions: no gateway connection, no always-on process, fits in the free tier.
- **Any feed.** Subreddits, blogs, Hacker News, Medium tags: anything with RSS or Atom.
- **Optional Reddit login.** Connected users get their personal home feed, score and comment counts, and fewer rate-limit errors.
- **Autocomplete** for source names as you type.
- **Smart selection.** Fast-moving feeds return the newest posts; slow blogs return a random sample, so repeat calls show variety.
- **Secure by default.** Every request is verified with Ed25519, and Reddit tokens are encrypted with AES-GCM before they're stored.

## Commands

| Command | What it does |
|---|---|
| `/posts source:<name> [limit]` | Latest posts from a configured source (default 5, max 10) |
| `/sources` | List every configured source |
| `/usage` | `/posts` calls used today against the daily budget |
| `/reddit connect` | Link your Reddit account (optional) |
| `/reddit home [limit]` | Your Reddit front page, visible only to you |
| `/reddit status` / `disconnect` | Check or remove the link (disconnect also revokes access on Reddit) |

## Tech stack

**Runtime:** Cloudflare Workers · **Storage:** Workers KV · **Language:** JavaScript (ES modules, no build step) · **Libraries:** [`discord-interactions`](https://github.com/discord/discord-interactions-js), [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) · **Tooling:** Wrangler · **Testing:** `node:test`, GitHub Actions

## Quick start

You need Node.js 20.10+, a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and a Discord account.

**1. Create the Discord app.** In the [Developer Portal](https://discord.com/developers/applications), click **New Application**. Copy the **Application ID** and **Public Key** (General Information) and the **bot token** (Bot → Reset Token).

**2. Invite it to your server.** Under **OAuth2 → URL Generator**, tick `bot` and `applications.commands`, then open the generated URL.

**3. Clone and install.**

```bash
git clone https://github.com/giorgimskh/discord-feed-bot.git
cd discord-feed-bot
npm install
cp feeds.example.json feeds.json
```

**4. Set up Cloudflare.**

```bash
npx wrangler login
npx wrangler kv namespace create FEED_STATE   # paste the printed id into wrangler.toml
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_APP_ID
```

**5. Deploy.**

```bash
npm run deploy
```

Copy the printed `https://….workers.dev` URL into **Interactions Endpoint URL** on the app's General Information page and click **Save**.

**6. Register the slash commands.** Get your server ID by right-clicking the server → **Copy Server ID** (turn on Developer Mode in Discord's Advanced settings first).

```bash
DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run register
```

Leave out `DISCORD_GUILD_ID` to register globally for every server (takes up to an hour to appear).

**7. Try it:** `/sources`, then `/posts source:programming`.

## Optional: Reddit login

Without this, subreddits still work through Reddit's public RSS feeds.

1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → **create another app** → choose **web app**. Set the redirect URI to your Worker URL plus `/reddit/callback`, e.g. `https://discord-feed-bot.you.workers.dev/reddit/callback`. Reddit may ask you to request API access first under its Responsible Builder Policy.
2. Add the credentials and an encryption key:

   ```bash
   npx wrangler secret put REDDIT_CLIENT_ID
   npx wrangler secret put REDDIT_CLIENT_SECRET
   openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
   ```

3. Run `npm run register` again, then `/reddit connect` in Discord.

## Adding sources

Sources live in `feeds.json` (your copy of `feeds.example.json`; it's gitignored). Redeploy after editing it.

```json
{
  "hn-frontpage": "https://hnrss.org/frontpage",
  "programming": { "subreddit": "programming" },
  "cf-blog": { "url": "https://blog.cloudflare.com/rss/", "category": "daily" },
  "bigthink": { "url": "https://bigthink.com/feeds/feed.rss", "category": "general" }
}
```

| Entry | Meaning | `/posts` returns |
|---|---|---|
| `"https://…"` | Any RSS/Atom feed | Random sample of the newest 50 |
| `{ "subreddit": "name" }` | A subreddit | Newest posts |
| `{ "url": "…", "category": "daily" }` | Feed you want in order | Newest posts |
| `{ "url": "…", "category": "general" }` | Slow-moving feed | Random sample of the newest 50 |

Names are matched case-insensitively, and a leading `/` is ignored.

## Local development

```bash
npm test                         # 21 tests, no accounts or network needed
cp .dev.vars.example .dev.vars   # fill in the values
npm run dev
```

The integration tests in `test/worker.test.js` drive the real Worker with Ed25519-signed interactions, an in-memory KV and a fake Reddit, covering the full OAuth flow.

Discord can't reach `localhost`. For a real round-trip, use `npx wrangler dev --remote` or a tunnel (`cloudflared tunnel --url http://localhost:8787`) and point the Interactions Endpoint URL at it.

## Design notes

- **Deferred replies.** Discord requires an answer within 3 seconds, and fetching a feed can take longer. `/posts` replies "thinking…" immediately, keeps working in `ctx.waitUntil()`, and delivers the results through a follow-up webhook.
- **RSS first.** Reddit's unauthenticated JSON API returns 403 to non-browser clients, so everyone gets RSS by default and OAuth is an opt-in upgrade. If an API call fails, the bot falls back to RSS.
- **Rate limits.** RSS fetches are edge-cached for 60 seconds, so bursts of identical requests don't reach Reddit.
- **Token security.** Reddit tokens are encrypted with AES-GCM before being written to KV. The OAuth `state` parameter is HMAC-signed instead of stored, because KV writes can take up to 60s to reach other Cloudflare locations. Both keys are derived from `TOKEN_ENCRYPTION_KEY` with HKDF.
- **Account-linking protection.** A connect link is tied to the Discord user who requested it. Before going to Reddit, it opens a confirmation page naming that Discord account, so someone tricked into opening another person's link can see it isn't theirs.

## Known limitations

- Discord shows at most 10 embeds per message, so `limit` is capped at 10.
- After `/reddit connect`, it can take up to a minute before the bot sees the connection (KV propagation).
- Random sampling only draws from a feed's newest 50 items.
