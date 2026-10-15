// Optional per-user Reddit login. A user runs /reddit connect and gets a
// link to LOGIN_PATH on this Worker, which shows the Discord account being
// connected before sending them on to Reddit. That step matters because the
// link is bound to whoever ran the command: someone tricked into opening
// another user's link would otherwise link their Reddit to that user's
// Discord account without noticing. After approval, Reddit redirects to
// CALLBACK_PATH, and the tokens are stored in FEED_STATE, encrypted, under
// the Discord user id.
//
// The OAuth `state` is HMAC-signed rather than stored in KV: the
// interaction (from Discord's servers) and the callback (from the user's
// browser) usually hit different Cloudflare locations, and a KV write in
// one location can take up to 60s to be readable in another.
import { encryptJson, decryptJson, signPayload, verifyPayload } from "./crypto.js";
import { REDDIT_USER_AGENT, RedditApiError } from "./reddit.js";

export const LOGIN_PATH = "/reddit/login";
export const CALLBACK_PATH = "/reddit/callback";
const SCOPES = "identity read";
const STATE_TTL_MS = 10 * 60 * 1000;
// Refresh a little before Reddit's expiry so a token can't lapse mid-request.
const EXPIRY_MARGIN_MS = 60 * 1000;

function tokenKey(discordUserId) {
  return `reddit:user:${discordUserId}`;
}

export function isRedditLoginConfigured(env) {
  return Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY && env.FEED_STATE);
}

function basicAuth(env) {
  return `Basic ${btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`)}`;
}

async function requestToken(env, params) {
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: basicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new RedditApiError(res.status);
  // Reddit reports some failures (e.g. a revoked refresh token) as HTTP 200
  // with an `error` field.
  const body = await res.json();
  if (body.error) throw new RedditApiError(400);
  return body;
}

async function saveTokens(env, discordUserId, record) {
  await env.FEED_STATE.put(tokenKey(discordUserId), await encryptJson(env.TOKEN_ENCRYPTION_KEY, record));
}

async function loadTokens(env, discordUserId) {
  const sealed = await env.FEED_STATE.get(tokenKey(discordUserId));
  if (!sealed) return null;
  try {
    return await decryptJson(env.TOKEN_ENCRYPTION_KEY, sealed);
  } catch {
    // Encrypted under a different TOKEN_ENCRYPTION_KEY; treat as disconnected.
    return null;
  }
}

// Link for the /reddit connect button. `displayName` is only shown on the
// confirmation page; `userId` is what the tokens get stored under.
export async function buildConnectUrl(env, origin, discordUserId, displayName) {
  const state = await signPayload(env.TOKEN_ENCRYPTION_KEY, {
    userId: discordUserId,
    displayName,
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  return `${origin}${LOGIN_PATH}?state=${encodeURIComponent(state)}`;
}

function buildAuthorizeUrl(env, origin, state) {
  const url = new URL("https://www.reddit.com/api/v1/authorize");
  url.searchParams.set("client_id", env.REDDIT_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", origin + CALLBACK_PATH);
  url.searchParams.set("duration", "permanent");
  url.searchParams.set("scope", SCOPES);
  return url.toString();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function htmlPage(title, message, { status = 200, action } = {}) {
  const button = action
    ? `<p><a href="${escapeHtml(action.href)}" style="display:inline-block;padding:.6rem 1.2rem;border-radius:6px;background:#ff4500;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>`
    : "";
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${button}</body>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" },
  });
}

async function readState(env, url) {
  const state = await verifyPayload(env.TOKEN_ENCRYPTION_KEY, url.searchParams.get("state"));
  return state && state.expiresAt >= Date.now() ? state : null;
}

const NOT_CONFIGURED_PAGE = ["Reddit login is not set up", "This bot has no Reddit app configured.", { status: 404 }];
const EXPIRED_PAGE = ["Link expired", "Run /reddit connect in Discord again to get a fresh link.", { status: 400 }];

export async function handleLoginPage(request, env) {
  if (!isRedditLoginConfigured(env)) return htmlPage(...NOT_CONFIGURED_PAGE);

  const url = new URL(request.url);
  const state = await readState(env, url);
  if (!state) return htmlPage(...EXPIRED_PAGE);

  return htmlPage(
    "Connect Reddit",
    `You're about to link your Reddit account to the Discord user ${state.displayName}. ` +
      "If that isn't you, close this page: someone else sent you their link.",
    { action: { label: "Continue to Reddit", href: buildAuthorizeUrl(env, url.origin, url.searchParams.get("state")) } }
  );
}

export async function handleOAuthCallback(request, env) {
  if (!isRedditLoginConfigured(env)) return htmlPage(...NOT_CONFIGURED_PAGE);

  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    return htmlPage("Reddit not connected", "You declined access on Reddit. Nothing was saved.");
  }

  const state = await readState(env, url);
  if (!state) return htmlPage(...EXPIRED_PAGE);

  let username;
  try {
    const tokens = await requestToken(env, {
      grant_type: "authorization_code",
      code: url.searchParams.get("code") ?? "",
      redirect_uri: url.origin + CALLBACK_PATH,
    });

    const meRes = await fetch("https://oauth.reddit.com/api/v1/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": REDDIT_USER_AGENT },
    });
    username = meRes.ok ? (await meRes.json()).name : null;

    await saveTokens(env, state.userId, {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      username,
    });
  } catch (err) {
    console.error(err);
    return htmlPage("Reddit not connected", "Reddit rejected the login. Run /reddit connect to try again.", { status: 502 });
  }

  return htmlPage(
    "Reddit connected",
    `Connected as u/${username ?? "unknown"}. You can close this tab and go back to Discord. ` +
      "It can take up to a minute before the bot sees the connection."
  );
}

// Returns a usable access token, or null if the user hasn't connected (or
// revoked access on Reddit, in which case the stale record is removed).
export async function getAccessToken(env, discordUserId) {
  if (!isRedditLoginConfigured(env) || !discordUserId) return null;

  const record = await loadTokens(env, discordUserId);
  if (!record) return null;
  if (record.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return record.accessToken;

  let refreshed;
  try {
    refreshed = await requestToken(env, { grant_type: "refresh_token", refresh_token: record.refreshToken });
  } catch (err) {
    if (err instanceof RedditApiError && (err.status === 400 || err.status === 401)) {
      await env.FEED_STATE.delete(tokenKey(discordUserId));
      return null;
    }
    throw err;
  }

  await saveTokens(env, discordUserId, {
    ...record,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  });
  return refreshed.access_token;
}

export async function getConnectedUsername(env, discordUserId) {
  if (!isRedditLoginConfigured(env)) return null;
  const record = await loadTokens(env, discordUserId);
  return record ? record.username ?? "unknown" : null;
}

// Deletes the stored tokens and asks Reddit to revoke them. Returns whether
// the user was connected.
export async function disconnectReddit(env, discordUserId) {
  const record = await loadTokens(env, discordUserId);
  if (!record) return false;

  await env.FEED_STATE.delete(tokenKey(discordUserId));
  const res = await fetch("https://www.reddit.com/api/v1/revoke_token", {
    method: "POST",
    headers: {
      Authorization: basicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: new URLSearchParams({ token: record.refreshToken, token_type_hint: "refresh_token" }),
  });
  if (!res.ok) console.error(`Reddit token revoke failed (HTTP ${res.status})`);
  return true;
}
