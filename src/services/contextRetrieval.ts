import { DateTime } from "luxon";

import { listItemsBetween, listManageableItems, listOpenTasks, listOverdueOpenItems } from "@/db/queries/items";

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
  const todayFrom = nowLocal.startOf("day").toUTC().toJSDate();
  const todayTo = nowLocal.endOf("day").toUTC().toJSDate();
  const tomorrowFrom = nowLocal.plus({ days: 1 }).startOf("day").toUTC().toJSDate();
  const tomorrowTo = nowLocal.plus({ days: 1 }).endOf("day").toUTC().toJSDate();
  const weekTo = nowLocal.plus({ days: 7 }).endOf("day").toUTC().toJSDate();

  const [
    facts,
    summaries,
    recentMessages,
    activeTasks,
    manageableItems,
    todayItems,
    tomorrowItems,
    overdueItems,
    weekItems,
  ] = await Promise.all([
    listRelevantMemoryFacts({ userId: params.userId, query: params.query, limit: 12 }),
    listRecentConversationSummaries(params.userId, 3),
    listRecentConversationMessages(params.userId, 10),
    listOpenTasks(params.userId, 20),
    listManageableItems(params.userId, 25),
    listItemsBetween({ userId: params.userId, from: todayFrom, to: todayTo, limit: 25 }),
    listItemsBetween({ userId: params.userId, from: tomorrowFrom, to: tomorrowTo, limit: 25 }),
    listOverdueOpenItems({ userId: params.userId, before: todayFrom, limit: 15 }),
    listItemsBetween({ userId: params.userId, from: todayFrom, to: weekTo, limit: 35 }),
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
    "Manageable current items:",
    manageableItems.length ? manageableItems.map(formatContextItem(params.timezone)).join("\n") : "- none",
    "",
    "Today:",
    todayItems.length ? todayItems.map(formatContextItem(params.timezone)).join("\n") : "- none",
    "",
    "Tomorrow:",
    tomorrowItems.length ? tomorrowItems.map(formatContextItem(params.timezone)).join("\n") : "- none",
    "",
    "Overdue:",
    overdueItems.length ? overdueItems.map(formatContextItem(params.timezone)).join("\n") : "- none",
    "",
    "Recurring reminders:",
    manageableItems
      .filter((item) => item.kind === "recurring_task")
      .map(formatContextItem(params.timezone))
      .join("\n") || "- none",
    "",
    "Unfinished training plans:",
    manageableItems
      .filter((item) => item.kind === "training" || item.metadata?.tentativeTrainingPlan === true)
      .map(formatContextItem(params.timezone))
      .join("\n") || "- none",
    "",
    "Next 7 days:",
    weekItems.length
      ? weekItems.map(formatContextItem(params.timezone)).join("\n")
      : "- none",
  ]
    .join("\n")
    .slice(0, 8000);
}

function formatContextItem(defaultTimezone: string) {
  return (item: {
    id: string;
    kind: string;
    title: string;
    startAt: Date | null;
    dueAt: Date | null;
    timezone: string;
    metadata: Record<string, unknown>;
  }) => {
    const when = item.startAt ?? item.dueAt;
    const local = when
      ? DateTime.fromJSDate(when, { zone: "utc" })
          .setZone(item.timezone || defaultTimezone)
          .toFormat("yyyy-MM-dd HH:mm")
      : "no time";
    const flags = [
      item.metadata?.isFloating === true ? "floating" : null,
      item.metadata?.tentative === true || item.metadata?.tentativeTrainingPlan === true
        ? "tentative"
        : null,
      item.metadata?.itemType ? `type=${String(item.metadata.itemType)}` : null,
      item.metadata?.orderIndex ? `order=${String(item.metadata.orderIndex)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `- id=${item.id}; ${local}: ${item.kind} ${item.title}${flags ? ` (${flags})` : ""}`;
  };
}
