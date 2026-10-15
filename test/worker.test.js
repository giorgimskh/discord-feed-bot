import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { decryptJson, encryptJson } from "../src/crypto.js";
import { ORIGIN, createEnv, mockFetch, interact, command, redditCommand, get } from "./helpers.js";

// Several tests exercise error paths on purpose; the Worker logs those.
console.error = () => {};

const TOKEN_KEY = "reddit:user:user-1";

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Older</title><link href="https://example.com/1"/><updated>2026-10-01T00:00:00Z</updated></entry>
<entry><title>Newer</title><link href="https://example.com/2"/><updated>2026-10-02T00:00:00Z</updated></entry>
</feed>`;

function listing(prefix, count = 3) {
  return {
    data: {
      children: Array.from({ length: count }, (_, i) => ({
        data: {
          title: `${prefix} ${i + 1}`,
          permalink: `/r/x/comments/${i}/`,
          created_utc: 1760000000 + i,
          score: 10 * (i + 1),
          num_comments: i,
          subreddit_name_prefixed: "r/x",
        },
      })),
    },
  };
}

// Fake Reddit: issues access-token-1, -2, … and a fixed refresh token.
function redditServer({ refreshFails = false } = {}) {
  let issued = 0;
  return mockFetch((url, init) => {
    const params = new URLSearchParams(init.body);
    if (url.href === "https://www.reddit.com/api/v1/access_token") {
      assert.equal(init.headers.get("Authorization"), `Basic ${btoa("client-id:client-secret")}`);
      if (params.get("grant_type") === "authorization_code") {
        assert.equal(params.get("redirect_uri"), `${ORIGIN}/reddit/callback`);
        return Response.json({ access_token: `access-token-${++issued}`, refresh_token: "refresh-token-secret", expires_in: 3600 });
      }
      if (refreshFails) return Response.json({ error: "invalid_grant" });
      return Response.json({ access_token: `access-token-${++issued}`, expires_in: 3600 });
    }
    if (url.href === "https://www.reddit.com/api/v1/revoke_token") return new Response(null, { status: 204 });
    if (url.href === "https://oauth.reddit.com/api/v1/me") return Response.json({ name: "reddit_alice" });
    if (url.hostname === "oauth.reddit.com" && url.pathname === "/best") {
      return Response.json(listing("home", Number(url.searchParams.get("limit"))));
    }
    if (url.hostname === "oauth.reddit.com") return Response.json(listing("api", Number(url.searchParams.get("limit"))));
    if (url.pathname.endsWith(".rss")) return new Response(atom);
  });
}

// Walks the whole browser flow: /reddit connect → login page → callback.
async function connect(env) {
  const reply = await interact(worker, env, redditCommand("connect"));
  const loginUrl = new URL(reply.data.components[0].components[0].url);
  const loginPage = await get(worker, env, loginUrl.pathname + loginUrl.search);
  const state = loginUrl.searchParams.get("state");
  const callback = await get(worker, env, `/reddit/callback?code=abc&state=${encodeURIComponent(state)}`);
  return { reply, loginUrl, loginPage, callback, state };
}

let env;
beforeEach(() => {
  env = createEnv();
});

test("rejects non-POST and unsigned requests, answers PING", async () => {
  assert.equal((await get(worker, env, "/")).status, 405);
  const unsigned = await worker.fetch(new Request(`${ORIGIN}/`, { method: "POST", body: "{}" }), env, {});
  assert.equal(unsigned.status, 401);
  assert.equal((await interact(worker, env, { type: 1 })).type, 1);
});

test("/posts on a subreddit uses RSS when the user hasn't connected Reddit", async () => {
  const { calls, followups } = redditServer();
  const reply = await interact(worker, env, command("posts", [{ name: "source", value: "programming" }]));

  assert.equal(reply.type, 5);
  assert.ok(calls.some((c) => c.url.pathname === "/r/programming/new/.rss"));
  assert.deepEqual(followups[0].embeds.map((e) => e.title), ["Newer", "Older"]);
});

test("/posts clamps limit to 1–10", async () => {
  const { followups } = redditServer();
  for (const [limit, expected] of [[0, 1], [-3, 1], [1, 1], [50, 2]]) {
    followups.length = 0;
    await interact(worker, env, command("posts", [{ name: "source", value: "programming" }, { name: "limit", value: limit }]));
    assert.equal(followups[0].embeds.length, expected, `limit ${limit}`);
  }
});

test("/reddit connect links to a confirmation page naming the Discord user", async () => {
  redditServer();
  const { reply, loginUrl, loginPage } = await connect(env);

  assert.equal(reply.data.flags, 64);
  assert.equal(loginUrl.origin + loginUrl.pathname, `${ORIGIN}/reddit/login`);
  const html = await loginPage.text();
  assert.match(html, /Discord user @alice/);

  const authorize = new URL(html.match(/href="([^"]+)"/)[1].replaceAll("&#38;", "&"));
  assert.equal(authorize.origin + authorize.pathname, "https://www.reddit.com/api/v1/authorize");
  assert.equal(authorize.searchParams.get("redirect_uri"), `${ORIGIN}/reddit/callback`);
  assert.equal(authorize.searchParams.get("scope"), "identity read");
});

test("callback stores tokens encrypted", async () => {
  redditServer();
  const { callback } = await connect(env);

  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /Connected as u\/reddit_alice/);
  const sealed = env.FEED_STATE.store.get(TOKEN_KEY);
  for (const secret of ["refresh-token-secret", "access-token-1", "reddit_alice"]) assert.ok(!sealed.includes(secret));
  assert.equal((await decryptJson(env.TOKEN_ENCRYPTION_KEY, sealed)).refreshToken, "refresh-token-secret");
});

test("login and callback reject tampered, missing or expired state", async () => {
  redditServer();
  const { state } = await connect(env);
  env.FEED_STATE.store.clear();
  const tampered = state.slice(0, -3) + "AAA";

  for (const path of ["/reddit/login", "/reddit/callback"]) {
    assert.equal((await get(worker, env, `${path}?code=abc&state=${tampered}`)).status, 400);
    assert.equal((await get(worker, env, `${path}?code=abc`)).status, 400);
  }
  assert.equal(env.FEED_STATE.store.has(TOKEN_KEY), false);
});

test("declining on Reddit stores nothing", async () => {
  redditServer();
  const res = await get(worker, env, "/reddit/callback?error=access_denied");
  assert.match(await res.text(), /declined/);
  assert.equal(env.FEED_STATE.store.size, 0);
});

test("connected users get subreddits from the API, with scores", async () => {
  const { calls, followups } = redditServer();
  await connect(env);
  await interact(worker, env, command("posts", [{ name: "source", value: "programming" }, { name: "limit", value: 2 }]));

  const apiCall = calls.find((c) => c.url.href.startsWith("https://oauth.reddit.com/r/programming/new"));
  assert.equal(apiCall.headers.get("Authorization"), "Bearer access-token-1");
  assert.ok(!calls.some((c) => c.url.pathname.endsWith(".rss")));
  assert.deepEqual(followups[0].embeds[0].fields.map((f) => f.name), ["Published", "Score", "Comments"]);
  assert.equal(followups[0].embeds[0].footer.text, "r/x");
});

test("/reddit home refreshes an expired token and replies privately", async () => {
  const { calls, followups } = redditServer();
  await connect(env);
  const record = await decryptJson(env.TOKEN_ENCRYPTION_KEY, env.FEED_STATE.store.get(TOKEN_KEY));
  env.FEED_STATE.store.set(TOKEN_KEY, await encryptJson(env.TOKEN_ENCRYPTION_KEY, { ...record, expiresAt: 0 }));

  const reply = await interact(worker, env, redditCommand("home", [{ name: "limit", value: 3 }]));

  assert.equal(reply.data.flags, 64);
  assert.equal(calls.find((c) => c.url.pathname === "/best").headers.get("Authorization"), "Bearer access-token-2");
  assert.equal(followups[0].flags, 64);
  assert.deepEqual(followups[0].embeds.map((e) => e.title), ["home 1", "home 2", "home 3"]);
  const saved = await decryptJson(env.TOKEN_ENCRYPTION_KEY, env.FEED_STATE.store.get(TOKEN_KEY));
  assert.equal(saved.accessToken, "access-token-2");
  assert.equal(saved.refreshToken, "refresh-token-secret");
});

test("access revoked on Reddit removes the record and falls back to RSS", async () => {
  redditServer();
  await connect(env);
  const record = await decryptJson(env.TOKEN_ENCRYPTION_KEY, env.FEED_STATE.store.get(TOKEN_KEY));
  env.FEED_STATE.store.set(TOKEN_KEY, await encryptJson(env.TOKEN_ENCRYPTION_KEY, { ...record, expiresAt: 0 }));

  const { calls } = redditServer({ refreshFails: true });
  await interact(worker, env, command("posts", [{ name: "source", value: "programming" }]));

  assert.ok(calls.some((c) => c.url.pathname.endsWith(".rss")));
  assert.equal(env.FEED_STATE.store.has(TOKEN_KEY), false);
});

test("/reddit status and disconnect", async () => {
  const { calls, followups } = redditServer();
  assert.match((await interact(worker, env, redditCommand("status"))).data.content, /haven't connected/);

  await connect(env);
  assert.equal((await interact(worker, env, redditCommand("status"))).data.content, "Connected as u/reddit_alice.");

  await interact(worker, env, redditCommand("disconnect"));
  assert.ok(calls.some((c) => c.url.href === "https://www.reddit.com/api/v1/revoke_token"));
  assert.match(followups.at(-1).content, /disconnected/);
  assert.equal(env.FEED_STATE.store.has(TOKEN_KEY), false);

  await interact(worker, env, redditCommand("home"));
  assert.match(followups.at(-1).content, /haven't connected/);
  assert.equal(followups.at(-1).flags, 64);
});

test("without Reddit credentials, /reddit explains and the bot still works", async () => {
  env = createEnv({ REDDIT_CLIENT_ID: undefined });
  const { calls } = redditServer();

  assert.match((await interact(worker, env, redditCommand("connect"))).data.content, /isn't set up/);
  assert.equal((await get(worker, env, "/reddit/login?state=x")).status, 404);
  assert.equal((await get(worker, env, "/reddit/callback?code=x")).status, 404);
  await interact(worker, env, command("posts", [{ name: "source", value: "programming" }]));
  assert.ok(calls.some((c) => c.url.pathname.endsWith(".rss")));
});

test("/posts and /reddit home count toward daily usage", async () => {
  redditServer();
  await connect(env);
  await interact(worker, env, command("posts", [{ name: "source", value: "programming" }]));
  await interact(worker, env, redditCommand("home"));

  const usage = await interact(worker, env, command("usage"));
  assert.match(usage.data.content, /2 \/ 500 used/);
});
