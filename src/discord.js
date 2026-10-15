const DISCORD_API = "https://discord.com/api/v10";
export const MAX_EMBEDS = 10;
const MAX_TITLE_LENGTH = 256;

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// Messages with this flag are only visible to the user who ran the command.
export const EPHEMERAL = 64;

// RSS entries carry only a date. Entries from Reddit's API (users who ran
// /reddit connect) also carry score, comment count and subreddit.
export function buildEmbed(entry) {
  const fields = [
    {
      name: "Published",
      value: entry.date ? new Date(entry.date).toISOString().slice(0, 10) : "Unknown",
      inline: true,
    },
  ];
  if (entry.score !== undefined && entry.score !== null) {
    fields.push(
      { name: "Score", value: String(entry.score), inline: true },
      { name: "Comments", value: String(entry.numComments), inline: true }
    );
  }

  const embed = { title: truncate(entry.title, MAX_TITLE_LENGTH), url: entry.link, fields };
  if (entry.subreddit) embed.footer = { text: entry.subreddit };
  return embed;
}

export function buildEmbeds(entries) {
  return entries.slice(0, MAX_EMBEDS).map(buildEmbed);
}

export function buildErrorFollowupPayload(message) {
  return { content: message };
}

export async function sendFollowup(appId, interactionToken, payload) {
  const res = await fetch(`${DISCORD_API}/webhooks/${appId}/${interactionToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Discord followup failed (${res.status}): ${text}`);
  }
}
