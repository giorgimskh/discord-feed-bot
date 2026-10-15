// Test doubles for the Worker runtime: an in-memory KV namespace, a fetch
// mock that routes by URL, and Ed25519-signed Discord interactions.
export const ORIGIN = "https://bot.example.workers.dev";

const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const publicKeyHex = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");

export function createKv() {
  const store = new Map();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
}

export function createEnv(overrides = {}) {
  return {
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_APP_ID: "app-id",
    DAILY_POST_LIMIT: "500",
    FEED_STATE: createKv(),
    REDDIT_CLIENT_ID: "client-id",
    REDDIT_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEY: "test-encryption-key",
    ...overrides,
  };
}

// Replaces global fetch. `handler(url, init)` returns a Response, or
// undefined for an unexpected request (which fails the test).
export function mockFetch(handler) {
  const calls = [];
  const followups = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init.headers);
    const body = init.body ? String(init.body) : "";
    calls.push({ url, method: init.method ?? "GET", headers, body });

    if (url.hostname === "discord.com") {
      followups.push(JSON.parse(body));
      return new Response("{}");
    }
    const res = await handler(url, { ...init, headers, body });
    if (!res) throw new Error(`Unexpected fetch: ${url}`);
    return res;
  };
  return { calls, followups };
}

async function signedRequest(payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body));
  return new Request(`${ORIGIN}/`, {
    method: "POST",
    body,
    headers: {
      "X-Signature-Ed25519": Buffer.from(signature).toString("hex"),
      "X-Signature-Timestamp": timestamp,
    },
  });
}

// Sends a signed interaction and waits for any ctx.waitUntil work.
export async function interact(worker, env, payload) {
  const pending = [];
  const res = await worker.fetch(await signedRequest(payload), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return res.json();
}

const user = { member: { user: { id: "user-1", username: "alice" } }, token: "interaction-token" };

export function command(name, options) {
  return { type: 2, ...user, data: { name, options } };
}

export function redditCommand(subcommand, options) {
  return command("reddit", [{ type: 1, name: subcommand, options }]);
}

export function get(worker, env, path) {
  return worker.fetch(new Request(ORIGIN + path), env, { waitUntil() {} });
}
