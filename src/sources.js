// Helpers for feeds.json entries, shared by index.js and autocomplete.js.

export function isRedditConfig(config) {
  return typeof config === "object" && config !== null && "subreddit" in config;
}

// Users may type a source with different case, stray whitespace, or a
// leading "/" by habit (e.g. "Worldnews", " worldnews", "/worldnews"), so
// names are always compared in this normalized form.
export function normalizeSourceName(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase();
}
