import type { PlannerItem } from "@/db/schema";
import type { TaskViewScope } from "@/db/queries/taskViewStates";

import { rememberTaskView } from "../state/taskViewState";
import { formatNumberedItem } from "./renderShared";
import { entityListKeyboard } from "@/bot/keyboards";

export type TaskViewSection = {
  title: string;
  items: PlannerItem[];
};

export async function renderAndSaveTaskView(params: {
  userId: string;
  timezone: string;
  viewType: TaskViewScope;
  title: string;
  sections: TaskViewSection[];
  intro?: string;
  emptyText?: string;
  footer?: string;
  metadata?: Record<string, unknown>;
}) {
  let displayIndex = 1;
  const normalizedSections = params.sections
    .map((section) => ({
      title: section.title,
      items: section.items.map((item) => ({
        ...item,
        metadata: { ...(item.metadata ?? {}), displayIndex: displayIndex++ },
      })),
    }))
    .filter((section) => section.items.length > 0);
  const orderedItems = normalizedSections.flatMap((section) => section.items);

  const lines = [params.title];
  if (params.intro) lines.push("", params.intro);
  if (!orderedItems.length) {
    lines.push("", params.emptyText ?? "Пока пусто.");
  } else {
    for (const section of normalizedSections) {
      lines.push("", `${section.title}:`);
      lines.push(...section.items.map((item) => formatNumberedItem(item, params.timezone)));
    }
    if (params.footer) lines.push("", params.footer);
  }

  const viewState = await rememberTaskView({
    userId: params.userId,
    scope: params.viewType,
    title: params.title,
    items: orderedItems,
    metadata: params.metadata,
  });

  return {
    reply: lines.join("\n"),
    items: orderedItems,
    viewState,
    replyMarkup: entityListKeyboard(
      orderedItems.map((item) => ({
        type: item.status === "active" ? "planner_item" : "history_item",
        id: item.id,
      })),
    ),
  };
}
