// Tracks how many times /posts has been called today against a
// self-imposed daily budget (not any real Cloudflare account limit — this
// bot's Worker/KV usage is well under Cloudflare's actual free-tier
// quotas). Stored in the FEED_STATE KV namespace, one counter key per
// UTC day, so it resets naturally at midnight UTC and cleans itself up
// via KV's expirationTtl.
const DEFAULT_DAILY_LIMIT = 500;
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60; // 2 days — comfortably outlives "today"

function todayKey() {
  return `usage:posts:${new Date().toISOString().slice(0, 10)}`;
}

function dailyLimit(env) {
  const parsed = Number.parseInt(env.DAILY_POST_LIMIT, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT;
}

export async function incrementPostsUsage(env) {
  if (!env.FEED_STATE) return;
  const key = todayKey();
  const current = Number.parseInt(await env.FEED_STATE.get(key), 10) || 0;
  await env.FEED_STATE.put(key, String(current + 1), { expirationTtl: COUNTER_TTL_SECONDS });
}

export async function getPostsUsage(env) {
  const limit = dailyLimit(env);

  if (!env.FEED_STATE) {
    return { count: 0, limit, remaining: limit, tracked: false };
  }

  const current = Number.parseInt(await env.FEED_STATE.get(todayKey()), 10) || 0;
  return { count: current, limit, remaining: Math.max(limit - current, 0), tracked: true };
}
