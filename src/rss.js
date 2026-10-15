import { XMLParser } from "fast-xml-parser";
import { sampleRandom } from "./random.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Decodes numeric character references (e.g. &#8217; -> ’) and a handful
  // of named HTML entities that plain XML doesn't recognize by default —
  // without this, titles/descriptions containing them (common in Reddit's
  // RSS output) come through with the raw entity still in the text.
  htmlEntities: true,
  // Active/large subreddits' RSS responses legitimately exceed
  // fast-xml-parser's default entity-expansion cap (1000), which throws
  // "Entity expansion limit exceeded". Raised to 10,000 for headroom while
  // keeping the other billion-laughs-style protections (size/depth/length
  // caps) at the library's own defaults, rather than disabling entity
  // limits altogether.
  processEntities: {
    enabled: true,
    maxEntitySize: 10000,
    maxExpansionDepth: 10,
    maxTotalExpansions: 10000,
    maxExpandedLength: 100000,
  },
});

// Reddit's RSS endpoints reject requests with no User-Agent (or a generic
// one) with a 429. A descriptive UA is harmless for blog/RSS-Bridge feeds
// too, so it's applied to every fetch here rather than special-cased.
const FEED_USER_AGENT = "discord-feed-bot/1.0";

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return value["#text"] ?? "";
  return String(value);
}

function atomLinkHref(link) {
  const links = asArray(link);
  if (links.length === 0) return "";
  const alternate = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate");
  return (alternate ?? links[0])["@_href"] ?? "";
}

function parseRss(channel) {
  return asArray(channel.item).map((item) => {
    const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : null;
    return {
      title: textOf(item.title),
      link: textOf(item.link),
      date: Number.isNaN(pubDate) ? null : pubDate,
    };
  });
}

function parseAtom(feed) {
  return asArray(feed.entry).map((entry) => {
    const rawDate = entry.updated ?? entry.published;
    const date = rawDate ? new Date(rawDate).getTime() : null;
    return {
      title: textOf(entry.title),
      link: atomLinkHref(entry.link),
      date: Number.isNaN(date) ? null : date,
    };
  });
}

// Reddit's per-subreddit .rss endpoint rate-limits fairly aggressively
// (HTTP 429) once a few requests land in quick succession — easy to hit
// when several /posts calls for the same subreddit happen close together.
// `cacheTtl` + `cacheEverything` makes Cloudflare's edge cache serve
// repeat requests for the same feed URL out of cache for a short window
// instead of re-hitting the origin every time, regardless of the origin's
// own Cache-Control headers.
const EDGE_CACHE_SECONDS = 60;

export async function fetchRssEntries(feedUrl, limit) {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": FEED_USER_AGENT },
    cf: { cacheTtl: EDGE_CACHE_SECONDS, cacheEverything: true },
  });
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error(`Feed "${feedUrl}" is rate-limiting requests right now — try again in a minute.`);
    }
    throw new Error(`Failed to fetch feed "${feedUrl}" (HTTP ${res.status}).`);
  }

  const xml = await res.text();
  const parsed = parser.parse(xml);

  let entries;
  if (parsed.rss?.channel) {
    entries = parseRss(parsed.rss.channel);
  } else if (parsed.feed) {
    entries = parseAtom(parsed.feed);
  } else {
    throw new Error(`Feed "${feedUrl}" is not a recognizable RSS or Atom feed.`);
  }

  entries.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  return entries.slice(0, limit);
}

// Wider than `limit` so the random pick actually has variety to draw from,
// rather than just always returning the newest `limit` items in a random
// order.
const RANDOM_POOL_LIMIT = 50;

export async function fetchRandomEntries(feedUrl, limit) {
  const entries = await fetchRssEntries(feedUrl, RANDOM_POOL_LIMIT);
  return sampleRandom(entries, limit);
}
