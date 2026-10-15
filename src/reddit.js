// Reddit blocks its unauthenticated .json listing endpoints for
// non-browser HTTP clients (confirmed with a verbatim browser User-Agent —
// still blocked), and a full OAuth app is more setup than this bot needs.
// Reddit's plain .rss feeds still work, so subreddit sources are fetched
// exactly like any other RSS source (see rss.js) — this just builds the
// feed URL. "new" is used unconditionally so entries come back
// chronological, matching every other RSS source; Reddit's RSS doesn't
// expose score/comment counts, so subreddit results carry no score-based
// filtering, same as any other RSS source.
export function subredditFeedUrl(subreddit) {
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new/.rss`;
}
