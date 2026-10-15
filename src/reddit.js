// Subreddits are fetched two ways:
// - Anyone: Reddit's public .rss feed, through the same code path as any
//   other RSS source (see rss.js). No score/comment data.
// - Users who ran /reddit connect: Reddit's OAuth API (oauth.reddit.com),
//   which has a higher rate limit than RSS and returns score/comment counts.
// Reddit's unauthenticated .json endpoints are not an option: they return
// 403 for non-browser clients.
export const REDDIT_USER_AGENT = "cloudflare-worker:discord-feed-bot:1.0";

export function subredditFeedUrl(subreddit) {
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new/.rss`;
}

export function subredditApiPath(subreddit) {
  return `/r/${encodeURIComponent(subreddit)}/new`;
}

// The user's personalized front page, built from their subscriptions.
export const HOME_FEED_PATH = "/best";

function listingToEntries(listing) {
  return (listing?.data?.children ?? []).map(({ data }) => ({
    title: data.title,
    link: `https://www.reddit.com${data.permalink}`,
    date: data.created_utc ? data.created_utc * 1000 : null,
    score: data.score,
    numComments: data.num_comments,
    subreddit: data.subreddit_name_prefixed,
  }));
}

export class RedditApiError extends Error {
  constructor(status) {
    super(`Reddit API request failed (HTTP ${status}).`);
    this.status = status;
  }
}

export async function fetchRedditListing(accessToken, path, limit) {
  const url = new URL(`https://oauth.reddit.com${path}`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("raw_json", "1");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": REDDIT_USER_AGENT },
  });
  if (!res.ok) throw new RedditApiError(res.status);
  return listingToEntries(await res.json());
}
