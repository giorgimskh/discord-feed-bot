// One-time (or whenever a command definition changes) script to register
// the /posts, /sources, /usage, and /reddit slash commands with Discord in a
// single run.
// This includes option-level changes (e.g. adding `autocomplete: true` to
// an option) — Discord won't pick those up until this is re-run.
// Run with:
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.js
//
// Set DISCORD_GUILD_ID too to register the command to a single guild
// instead of globally — guild commands show up instantly, global commands
// can take up to an hour to propagate. Useful for fast iteration.

const appId = process.env.DISCORD_APP_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !botToken) {
  console.error("Missing DISCORD_APP_ID or DISCORD_BOT_TOKEN in the environment.");
  process.exit(1);
}

const commands = [
  {
    name: "posts",
    description: "Fetch recent posts from a subreddit or configured RSS feed",
    options: [
      {
        name: "source",
        description: "Feed name from feeds.json (subreddit or blog/RSS-Bridge feed)",
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
      {
        name: "limit",
        description: "Number of posts to return (default 5)",
        type: 4, // INTEGER
        required: false,
      },
    ],
  },
  {
    name: "sources",
    description: "List all available source names for /posts",
  },
  {
    name: "usage",
    description: "Show how many /posts requests have been used today and how many remain",
  },
  {
    name: "reddit",
    description: "Connect your Reddit account for your home feed and fewer rate limits",
    options: [
      { name: "connect", description: "Link your Reddit account", type: 1 }, // SUB_COMMAND
      { name: "status", description: "Show which Reddit account is linked", type: 1 },
      { name: "disconnect", description: "Unlink your Reddit account and revoke access", type: 1 },
      {
        name: "home",
        description: "Show your Reddit front page (only visible to you)",
        type: 1,
        options: [
          { name: "limit", description: "Number of posts to return (default 5)", type: 4, required: false },
        ],
      },
    ],
  },
];

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

const body = await res.text();
console.log(`Status: ${res.status}`);
console.log(body);

if (!res.ok) {
  process.exit(1);
}

console.log(
  guildId
    ? `Registered /posts, /sources, /usage, and /reddit commands to guild ${guildId} (should be available immediately).`
    : "Registered /posts, /sources, /usage, and /reddit commands globally (may take up to an hour to propagate)."
);
