import { createHash } from "node:crypto";

import { parseRussianDateTime, parseRussianTimeRange } from "@/services/russianDateTime";
import { capitalizeFirstLetter } from "@/domain/titleSanitizer";

export type PinnedContextIntent =
  | {
      type: "create";
      codeword: string;
      category: "car_location" | "general";
      title: string;
      body: string;
      textHash: string;
    }
  | { type: "query"; category: "car_location" | "general"; query: string }
  | { type: "delete"; category: "car_location" | "general"; query: string }
  | { type: "list"; category: "all" };

const CREATE_PREFIXES = [
  "отдельное напоминание:",
  "отдельная заметка:",
  "закрепи:",
  "закрепленная заметка:",
  "закреплённая заметка:",
  "запомни отдельно:",
  "pinned note:",
  "separate reminder:",
];

export function parsePinnedContextIntent(params: {
  text: string;
  timezone: string;
  now: Date;
}): PinnedContextIntent | null {
  const text = params.text.trim();
  const normalized = normalizeRu(text);

  const deleteIntent = parseDeleteIntent(normalized);
  if (deleteIntent) return deleteIntent;

  if (
    /^(?:покажи\s+)?(?:отдельные\s+напоминания|закрепленн(?:ые|ыеся)\s+заметки|закрепленные\s+заметки|закреплённые\s+заметки)\??$/i.test(
      normalized,
    )
  ) {
    return { type: "list", category: "all" };
  }

  if (/^(?:где\s+(?:моя\s+)?машина|где\s+я\s+оставил\s+машину|где\s+припаркована\s+машина)\??$/i.test(normalized)) {
    return { type: "query", category: "car_location", query: "машина" };
  }

  const prefixed = parsePrefixedCreate(text, normalized, params);
  if (prefixed) return prefixed;

  const carCreate = parseCarLocationCreate(text, normalized, params);
  if (carCreate) return carCreate;

  if (/^car parked:/i.test(text)) {
    const body = text.replace(/^car parked:\s*/i, "").trim();
    return body
      ? buildCreateIntent({ codeword: "car parked", category: "car_location", body })
      : null;
  }

  return null;
}

export function isPinnedContextNote(item: { kind?: string | null; metadata?: Record<string, unknown> | null }) {
  return item.kind === "note" && item.metadata?.pinnedContext === true;
}

export function formatPinnedContextNoteLine(item: {
  title: string;
  description: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const icon = item.metadata?.pinnedCategory === "car_location" ? "🚗" : "📌";
  return `${icon} ${item.title}${item.description ? ` — ${item.description}` : ""}`;
}

export function pinnedContextTextHash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function parsePrefixedCreate(
  text: string,
  normalized: string,
  params: { timezone: string; now: Date },
) {
  for (const prefix of CREATE_PREFIXES) {
    if (!normalized.startsWith(prefix)) continue;
    if (hasExplicitSchedule(text, params)) return null;
    const body = text.slice(prefix.length).trim();
    if (!body) return null;
    return buildCreateIntent({
      codeword: prefix.replace(/:$/, ""),
      category: /машин|car/.test(normalized) ? "car_location" : "general",
      body,
    });
  }
  return null;
}

function parseCarLocationCreate(
  text: string,
  normalized: string,
  params: { timezone: string; now: Date },
) {
  if (hasExplicitSchedule(text, params)) return null;
  if (
    !/^(?:где\s+машина:|где\s+оставил\s+машину:|машину\s+оставил|я\s+оставил\s+машину)/i.test(
      normalized,
    )
  ) {
    return null;
  }
  return buildCreateIntent({
    codeword: "машину оставил",
    category: "car_location",
    body: text.replace(/^где\s+(?:оставил\s+)?машина:\s*/i, "").trim(),
  });
}

function buildCreateIntent(params: {
  codeword: string;
  category: "car_location" | "general";
  body: string;
}): PinnedContextIntent {
  const cleaned = cleanPinnedBody(params.body, params.category);
  return {
    type: "create",
    codeword: params.codeword,
    category: params.category,
    title: params.category === "car_location" ? "Машина" : inferTitle(cleaned),
    body: cleaned,
    textHash: pinnedContextTextHash(params.body),
  };
}

function parseDeleteIntent(normalized: string): PinnedContextIntent | null {
  if (!/^(?:удали|убери|очисти|сними)\b/i.test(normalized)) return null;
  if (!/(?:закреп|отдельн|заметк|напоминан|машин)/i.test(normalized)) return null;
  return {
    type: "delete",
    category: /машин/i.test(normalized) ? "car_location" : "general",
    query: /машин/i.test(normalized) ? "машина" : normalized,
  };
}

function cleanPinnedBody(body: string, category: "car_location" | "general") {
  let value = body
    .replace(/^[:\s-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (category === "car_location") {
    value = value
      .replace(/^машину\s+оставил(?:а)?\s+/i, "")
      .replace(/^я\s+оставил(?:а)?\s+машину\s+/i, "")
      .replace(/^машина\s+(?:стоит|припаркована)\s+/i, "")
      .replace(/^на\s+парковке\s+/i, "парковка ")
      .trim();
  }
  value = value.replace(/[.]+$/g, "").trim();
  return capitalizeFirstLetter(value);
}

function inferTitle(body: string) {
  const first = body.split(/[,.—-]/)[0]?.trim() || "Заметка";
  return capitalizeFirstLetter(first.slice(0, 60));
}

function hasExplicitSchedule(text: string, params: { timezone: string; now: Date }) {
  const range = parseRussianTimeRange({ text, timezone: params.timezone, now: params.now });
  if (range) return true;
  const dateTime = parseRussianDateTime({ text, timezone: params.timezone, now: params.now });
  if (!dateTime) return false;
  if (dateTime.source !== "time_only") return true;
  return /(?:^|\s)(?:в|во|к|на)\s*\d{1,2}[.:]\d{2}(?=\s|$|[,.;:!?])/i.test(normalizeRu(text));
}

function normalizeRu(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
