import { DateTime } from "luxon";

export const ORTHODONTIST_TEMPLATE_VERSION = "v2260";

export type OrthodontistReminderTemplateEntry = {
  fireAt: DateTime;
  minutesBefore: number;
  relativeLabel: string;
  eventMorningSet: boolean;
  templateRole: "week" | "three_days" | "visit_morning" | "two_hours" | "thirty_minutes";
};

export function isOrthodontistVisitTitle(title: string) {
  return /ортодонт|ортодон/iu.test(title);
}

export function buildOrthodontistReminderTemplate(params: {
  eventStart: DateTime;
  now?: DateTime;
}) {
  const start = params.eventStart;
  const candidates: OrthodontistReminderTemplateEntry[] = [
    entry(start.minus({ weeks: 1 }), start, "за неделю", "week"),
    entry(start.minus({ days: 3 }), start, "за 3 дня", "three_days"),
  ];
  const morning = start.startOf("day").set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  if (morning <= start.minus({ minutes: 15 })) {
    candidates.push({
      ...entry(morning, start, "утром в день визита", "visit_morning"),
      eventMorningSet: true,
    });
  }
  candidates.push(
    entry(start.minus({ hours: 2 }), start, "за 2 часа", "two_hours"),
    entry(start.minus({ minutes: 30 }), start, "за 30 минут", "thirty_minutes"),
  );
  return candidates.filter((candidate) => !params.now || candidate.fireAt > params.now);
}

export function orthodontistTemplateSignature(
  entries: Array<Pick<OrthodontistReminderTemplateEntry, "fireAt" | "templateRole">>,
) {
  return entries
    .map((entry) => `${entry.templateRole}:${entry.fireAt.toUTC().toISO()}`)
    .sort()
    .join("|");
}

function entry(
  fireAt: DateTime,
  start: DateTime,
  relativeLabel: string,
  templateRole: OrthodontistReminderTemplateEntry["templateRole"],
): OrthodontistReminderTemplateEntry {
  return {
    fireAt,
    minutesBefore: Math.max(1, Math.round(start.diff(fireAt, "minutes").minutes)),
    relativeLabel,
    eventMorningSet: false,
    templateRole,
  };
}
