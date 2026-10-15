import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptJson, decryptJson, signPayload, verifyPayload } from "../src/crypto.js";
import { buildSourceSearchIndex, searchSources } from "../src/autocomplete.js";
import { normalizeSourceName } from "../src/sources.js";
import { fetchRssEntries } from "../src/rss.js";
import { buildEmbed } from "../src/discord.js";
import { mockFetch } from "./helpers.js";

test("encryptJson round-trips and fails with the wrong key", async () => {
  const sealed = await encryptJson("key-a", { token: "secret" });
  assert.deepEqual(await decryptJson("key-a", sealed), { token: "secret" });
  await assert.rejects(decryptJson("key-b", sealed));
  assert.notEqual(sealed, await encryptJson("key-a", { token: "secret" }), "fresh IV each time");
});

test("signed payloads verify only with the same key and untouched", async () => {
  const token = await signPayload("key-a", { userId: "1" });
  assert.deepEqual(await verifyPayload("key-a", token), { userId: "1" });
  assert.equal(await verifyPayload("key-b", token), null);
  assert.equal(await verifyPayload("key-a", token.replace(/^./, "x")), null);
  assert.equal(await verifyPayload("key-a", "garbage"), null);
});

test("normalizeSourceName ignores case, whitespace and leading slashes", () => {
  assert.equal(normalizeSourceName("  /WorldNews "), "worldnews");
});

test("autocomplete ranks prefix, then substring, then metadata matches", () => {
  const index = buildSourceSearchIndex({
    "hn-frontpage": "https://hnrss.org/frontpage",
    programming: { subreddit: "programming" },
    "learn-programming": { subreddit: "learnprogramming" },
    "rust-news": { subreddit: "rust" },
  });
  assert.deepEqual(searchSources(index, "prog"), ["programming", "learn-programming"]);
  assert.deepEqual(searchSources(index, "reddit"), ["learn-programming", "programming", "rust-news"]);
  assert.equal(searchSources(index, "").length, 4);
});

test("RSS and Atom feeds parse to the same shape, newest first, entities decoded", async () => {
  mockFetch((url) =>
    url.pathname === "/rss"
      ? new Response(`<rss><channel>
          <item><title>Tom&#8217;s post</title><link>https://a/1</link><pubDate>Mon, 01 Sep 2025 00:00:00 GMT</pubDate></item>
          <item><title>Later</title><link>https://a/2</link><pubDate>Tue, 02 Sep 2025 00:00:00 GMT</pubDate></item>
        </channel></rss>`)
      : new Response(`<feed><entry><title>Atom</title><link rel="alternate" href="https://b/1"/><updated>2025-09-01T00:00:00Z</updated></entry></feed>`)
  );

  const rss = await fetchRssEntries("https://feeds.test/rss", 10);
  assert.deepEqual(rss.map((e) => e.title), ["Later", "Tom’s post"]);
  const atom = await fetchRssEntries("https://feeds.test/atom", 10);
  assert.deepEqual(atom, [{ title: "Atom", link: "https://b/1", date: Date.UTC(2025, 8, 1) }]);
});

test("feed errors become readable messages", async () => {
  mockFetch((url) => new Response("", { status: url.pathname === "/busy" ? 429 : 500 }));
  await assert.rejects(fetchRssEntries("https://feeds.test/busy", 5), /rate-limiting/);
  await assert.rejects(fetchRssEntries("https://feeds.test/down", 5), /HTTP 500/);
});

test("embeds truncate long titles and only show scores when present", () => {
  const plain = buildEmbed({ title: "x".repeat(300), link: "https://a", date: null });
  assert.equal(plain.title.length, 256);
  assert.deepEqual(plain.fields.map((f) => f.name), ["Published"]);
  assert.equal(plain.footer, undefined);
});
