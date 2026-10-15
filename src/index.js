import { verifyKey, InteractionType, InteractionResponseType } from "discord-interactions";
import feeds from "../feeds.json";
import { fetchRssEntries, fetchRandomEntries } from "./rss.js";
import { subredditFeedUrl, subredditApiPath, HOME_FEED_PATH, fetchRedditListing } from "./reddit.js";
import {
  CALLBACK_PATH,
  isRedditLoginConfigured,
  buildConnectUrl,
  handleOAuthCallback,
  getAccessToken,
  getConnectedUsername,
  disconnectReddit,
} from "./reddit-oauth.js";
import { incrementPostsUsage, getPostsUsage } from "./usage.js";
import { EPHEMERAL, buildEmbeds, buildErrorFollowupPayload, sendFollowup } from "./discord.js";
import { buildSourceSearchIndex, searchSources } from "./autocomplete.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message, status) {
  return json({ error: message }, status);
}

// Guild interactions carry the user under `member`, DMs under `user`.
function discordUserId(interaction) {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

function reply(content, { ephemeral = false, components } = {}) {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, ...(ephemeral && { flags: EPHEMERAL }), ...(components && { components }) },
  });
}

// Acknowledges right away (Discord's 3-second deadline) and runs `work` in
// the background. Errors thrown by `work` become the follow-up message.
function deferred(ctx, env, interaction, work, { ephemeral = false } = {}) {
  const flags = ephemeral ? { flags: EPHEMERAL } : {};
  ctx.waitUntil(
    work().catch((err) => {
      console.error(err);
      return sendFollowup(env.DISCORD_APP_ID, interaction.token, {
        ...buildErrorFollowupPayload(err.message),
        ...flags,
      });
    })
  );
  return json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: flags });
}

function parseOptions(options) {
  const opts = { source: null, limit: 5 };
  for (const opt of options ?? []) {
    if (opt.name === "source") opts.source = opt.value;
    if (opt.name === "limit") opts.limit = opt.value;
  }
  return opts;
}

export function isRedditConfig(config) {
  return typeof config === "object" && config !== null && "subreddit" in config;
}

// Discord's `source` option is free-text (no choices/autocomplete), so it's
// prone to case differences, stray whitespace, or a leading "/" a user
// might type by habit (e.g. "Worldnews", " worldnews", "/worldnews"). Feed
// names are matched case-insensitively against this normalized form rather
// than against feeds.json keys directly.
export function normalizeSourceName(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase();
}

const feedsByNormalizedName = new Map(
  Object.keys(feeds).map((name) => [normalizeSourceName(name), name])
);

const sourceSearchIndex = buildSourceSearchIndex(feeds);

function resolveSource(rawSource) {
  const canonicalName = feedsByNormalizedName.get(normalizeSourceName(rawSource));
  return canonicalName ? { name: canonicalName, config: feeds[canonicalName] } : null;
}

// A non-Reddit source's `url` is a plain string for legacy RSS entries, or
// `config.url` for entries that also carry a `category` (daily/general).
// `url` can be `null` as a placeholder for a source that doesn't have a
// working feed URL yet.
function getFeedUrl(config) {
  return typeof config === "string" ? config : config.url;
}

function getCategory(config) {
  return typeof config === "object" && config !== null && typeof config.category === "string"
    ? config.category
    : null;
}

// Sources flagged "daily" always show the latest N. Subreddits do too,
// unconditionally — see the call site in handlePostsCommand for why.
function isDailyCategory(config) {
  return getCategory(config) === "daily";
}

// What /posts actually does for a source — shown in /sources so the label
// matches real behavior instead of just echoing the "daily"/"general"
// feeds.json flag (which alone doesn't capture that Reddit sources also
// always show the latest, unrandomized, regardless of category).
function selectionMode(config) {
  return isRedditConfig(config) || isDailyCategory(config) ? "latest" : "random";
}

const REDDIT_API_MAX_LIMIT = 100;

// Users who ran /reddit connect go through Reddit's API (higher rate limit,
// plus score/comment counts). Everyone else, and any API failure, falls
// back to the public RSS feed.
async function fetchSubredditEntries(env, interaction, subreddit, limit) {
  try {
    const accessToken = await getAccessToken(env, discordUserId(interaction));
    if (accessToken) {
      const apiLimit = Math.min(Math.max(limit, 1), REDDIT_API_MAX_LIMIT);
      const entries = await fetchRedditListing(accessToken, subredditApiPath(subreddit), apiLimit);
      return entries.slice(0, limit);
    }
  } catch (err) {
    console.error(`Reddit API failed, falling back to RSS: ${err.message}`);
  }
  return fetchRssEntries(subredditFeedUrl(subreddit), limit);
}

async function handlePostsCommand(opts, interaction, env) {
  await incrementPostsUsage(env);

  const { source: rawSource, limit } = opts;
  const resolved = resolveSource(rawSource);

  if (!resolved) {
    const available = Object.keys(feeds).sort().join(", ");
    throw new Error(`Unknown source "${rawSource}". Configured sources: ${available}`);
  }

  const { name: source, config } = resolved;

  // Reddit and "daily" sources always get the latest N — no shared "last
  // seen" state, so one user's /posts call never affects another's.
  // Everything else (website/blog sources) gets a random sample instead,
  // since those feeds move slowly enough that "latest N" would otherwise
  // show the same handful of articles on every call.
  let entries;
  if (isRedditConfig(config)) {
    entries = await fetchSubredditEntries(env, interaction, config.subreddit, limit);
  } else {
    const feedUrl = getFeedUrl(config);
    if (!feedUrl) {
      throw new Error(`Source "${source}" doesn't have a feed URL configured yet in feeds.json.`);
    }
    entries = isDailyCategory(config)
      ? await fetchRssEntries(feedUrl, limit)
      : await fetchRandomEntries(feedUrl, limit);
  }

  if (entries.length === 0) {
    await sendFollowup(env.DISCORD_APP_ID, interaction.token, { content: "No posts found." });
    return;
  }

  await sendFollowup(env.DISCORD_APP_ID, interaction.token, { embeds: buildEmbeds(entries) });
}

function formatSourceList(names) {
  if (names.length === 0) return "_none configured_";
  return names.map((name) => `- \`${name}\` (${selectionMode(feeds[name])})`).join("\n");
}

function handleAutocompleteCommand(interaction) {
  const focused = (interaction.data.options ?? []).find((opt) => opt.focused);
  const query = focused?.name === "source" ? String(focused.value ?? "") : "";
  const matches = searchSources(sourceSearchIndex, query, 25);

  return json({
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices: matches.map((name) => ({ name, value: name })) },
  });
}

function handleSourcesCommand() {
  const names = Object.keys(feeds).sort();
  const redditNames = names.filter((name) => isRedditConfig(feeds[name]));
  const websiteNames = names.filter((name) => !isRedditConfig(feeds[name]));

  const content = [
    "**Available sources for /posts:**",
    `**Reddit:**\n${formatSourceList(redditNames)}`,
    `**Websites:**\n${formatSourceList(websiteNames)}`,
  ].join("\n\n");

  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content },
  });
}

async function handleUsageCommand(env) {
  const { count, limit, remaining, tracked } = await getPostsUsage(env);
  const note = tracked ? "" : " (FEED_STATE KV not bound — usage isn't being tracked.)";

  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `**/posts usage today:** ${count} / ${limit} used — ${remaining} remaining.${note}`,
    },
  });
}

const NOT_CONNECTED = "You haven't connected a Reddit account. Run `/reddit connect` first.";

async function handleRedditHome(opts, interaction, env) {
  await incrementPostsUsage(env);

  const accessToken = await getAccessToken(env, discordUserId(interaction));
  if (!accessToken) throw new Error(NOT_CONNECTED);

  const limit = Math.min(Math.max(opts.limit, 1), REDDIT_API_MAX_LIMIT);
  const entries = await fetchRedditListing(accessToken, HOME_FEED_PATH, limit);
  const payload = entries.length > 0 ? { embeds: buildEmbeds(entries) } : { content: "Your home feed is empty." };
  await sendFollowup(env.DISCORD_APP_ID, interaction.token, { ...payload, flags: EPHEMERAL });
}

async function handleRedditCommand(interaction, env, ctx, origin) {
  if (!isRedditLoginConfigured(env)) {
    return reply("Reddit login isn't set up on this bot.", { ephemeral: true });
  }

  const subcommand = interaction.data.options?.[0];
  const userId = discordUserId(interaction);

  switch (subcommand?.name) {
    case "connect": {
      const url = await buildConnectUrl(env, origin, userId);
      return reply("Approve the bot on Reddit to see your home feed and get fewer rate-limit errors. The link expires in 10 minutes.", {
        ephemeral: true,
        components: [{ type: 1, components: [{ type: 2, style: 5, label: "Connect Reddit", url }] }],
      });
    }
    case "status": {
      const username = await getConnectedUsername(env, userId);
      return reply(username ? `Connected as u/${username}.` : NOT_CONNECTED, { ephemeral: true });
    }
    case "disconnect":
      return deferred(ctx, env, interaction, async () => {
        const wasConnected = await disconnectReddit(env, userId);
        await sendFollowup(env.DISCORD_APP_ID, interaction.token, {
          content: wasConnected ? "Reddit disconnected and access revoked." : NOT_CONNECTED,
          flags: EPHEMERAL,
        });
      }, { ephemeral: true });
    case "home":
      return deferred(ctx, env, interaction, () =>
        handleRedditHome(parseOptions(subcommand.options), interaction, env), { ephemeral: true });
    default:
      return errorResponse("Unknown subcommand", 400);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === CALLBACK_PATH) {
      return handleOAuthCallback(request, env);
    }

    if (request.method !== "POST") {
      return errorResponse("Expected POST", 405);
    }

    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    const rawBody = await request.text();

    const isValid =
      signature &&
      timestamp &&
      (await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY));

    if (!isValid) {
      return errorResponse("Bad request signature", 401);
    }

    let interaction;
    try {
      interaction = JSON.parse(rawBody);
    } catch {
      return errorResponse("Malformed JSON body", 400);
    }

    if (interaction.type === InteractionType.PING) {
      return json({ type: InteractionResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
      if (interaction.data.name === "posts") {
        return handleAutocompleteCommand(interaction);
      }
      return json({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices: [] },
      });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const commandName = interaction.data.name;

      if (commandName === "sources") {
        return handleSourcesCommand();
      }

      if (commandName === "usage") {
        return await handleUsageCommand(env);
      }

      if (commandName === "reddit") {
        return await handleRedditCommand(interaction, env, ctx, url.origin);
      }

      if (commandName === "posts") {
        const opts = parseOptions(interaction.data.options);
        return deferred(ctx, env, interaction, () => handlePostsCommand(opts, interaction, env));
      }
    }

    return errorResponse("Unknown interaction", 400);
  },
};
