import { normalizeSourceName, isRedditConfig } from "./index.js";

// One searchable entry per feeds.json source: the normalized key name
// (highest-priority match target) plus a lowercased blob of metadata
// (subreddit, a synthetic "reddit" tag, category) that lets natural terms
// like "reddit" or "daily" surface sources that don't literally contain
// that word in their key.
export function buildSourceSearchIndex(feeds) {
  return Object.keys(feeds).map((name) => {
    const config = feeds[name];
    const isReddit = isRedditConfig(config);
    const metaParts = [
      isReddit ? config.subreddit : null,
      isReddit ? "reddit" : null,
      typeof config === "object" && config !== null && typeof config.category === "string"
        ? config.category
        : null,
    ].filter(Boolean);

    return {
      name,
      normalizedName: normalizeSourceName(name),
      metadataText: metaParts.join(" ").toLowerCase(),
    };
  });
}

// Tiered substring search: exact-prefix matches on the name rank above
// substring matches on the name, which rank above matches found only in
// metadata. An empty query (Discord fires autocomplete on focus, before any
// typing) returns the full list alphabetically instead of nothing.
export function searchSources(index, rawQuery, limit = 25) {
  const query = normalizeSourceName(rawQuery);

  if (!query) {
    return index
      .map((source) => source.name)
      .sort()
      .slice(0, limit);
  }

  const startsWith = [];
  const includesName = [];
  const includesMetadata = [];

  for (const source of index) {
    if (source.normalizedName.startsWith(query)) {
      startsWith.push(source.name);
    } else if (source.normalizedName.includes(query)) {
      includesName.push(source.name);
    } else if (source.metadataText.includes(query)) {
      includesMetadata.push(source.name);
    }
  }

  startsWith.sort();
  includesName.sort();
  includesMetadata.sort();

  return [...startsWith, ...includesName, ...includesMetadata].slice(0, limit);
}
