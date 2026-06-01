import { DateTime } from "luxon";

import { listItemsBetween, listOpenTasks } from "@/db/queries/items";

import { listRecentConversationMessages } from "./conversation";
import { listRecentConversationSummaries, listRelevantMemoryFacts } from "./memory";

export async function buildActiveContext(params: {
  userId: string;
  timezone: string;
  query: string;
  now?: Date;
}): Promise<string> {
  const now = params.now ?? new Date();
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(params.timezone);
  const weekTo = nowLocal.plus({ days: 7 }).endOf("day").toUTC().toJSDate();

  const [facts, summaries, recentMessages, activeTasks, weekItems] = await Promise.all([
    listRelevantMemoryFacts({ userId: params.userId, query: params.query, limit: 12 }),
    listRecentConversationSummaries(params.userId, 3),
    listRecentConversationMessages(params.userId, 10),
    listOpenTasks(params.userId, 20),
    listItemsBetween({ userId: params.userId, from: now, to: weekTo, limit: 25 }),
  ]);

  return [
    "Memory facts:",
    facts.length
      ? facts.map((fact) => `- [${fact.category}] ${fact.content}`).join("\n")
      : "- none",
    "",
    "Conversation summaries:",
    summaries.length ? summaries.map((summary) => `- ${summary.summary}`).join("\n") : "- none",
    "",
    "Recent messages:",
    recentMessages.length
      ? recentMessages
          .reverse()
          .map((message) => `- ${message.role}: ${message.transcript ?? message.text ?? ""}`)
          .join("\n")
      : "- none",
    "",
    "Active tasks:",
    activeTasks.length
      ? activeTasks.map((item) => `- ${item.kind}: ${item.title}`).join("\n")
      : "- none",
    "",
    "Next 7 days:",
    weekItems.length
      ? weekItems
          .map((item) => {
            const when = item.startAt ?? item.dueAt;
            const local = when
              ? DateTime.fromJSDate(when, { zone: "utc" })
                  .setZone(item.timezone || params.timezone)
                  .toFormat("yyyy-MM-dd HH:mm")
              : "no time";
            return `- ${local}: ${item.kind} ${item.title}`;
          })
          .join("\n")
      : "- none",
  ]
    .join("\n")
    .slice(0, 8000);
}
