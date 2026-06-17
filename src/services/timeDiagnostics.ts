import { DateTime } from "luxon";

import { formatRuWeekdayDateRange, localIsoToUtcDate } from "@/domain/dateTime";
import { getOwnerTimezone } from "@/lib/env";

export type OwnerTimeDebug = {
  ownerTimezone: string;
  serverTimezone: string;
  currentUtcTime: string;
  currentOwnerLocalTime: string;
  sampleInput: string;
  sampleLocalIso: string;
  sampleStoredUtc: string;
  sampleRendered: string;
};

export function getOwnerTimeDebug(now = new Date()): OwnerTimeDebug {
  const ownerTimezone = getOwnerTimezone();
  const currentUtc = DateTime.fromJSDate(now, { zone: "utc" });
  const currentOwner = currentUtc.setZone(ownerTimezone);
  const sampleLocal = nextFridayAt2130(currentOwner);
  const sampleStoredUtc = localIsoToUtcDate(
    sampleLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    ownerTimezone,
  );

  return {
    ownerTimezone,
    serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
    currentUtcTime: currentUtc.toISO({ suppressMilliseconds: true }) ?? now.toISOString(),
    currentOwnerLocalTime:
      currentOwner.toISO({ suppressMilliseconds: true }) ?? currentOwner.toString(),
    sampleInput: "пятница 21.30",
    sampleLocalIso: sampleLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    sampleStoredUtc: sampleStoredUtc.toISOString(),
    sampleRendered: formatRuWeekdayDateRange(
      sampleStoredUtc,
      DateTime.fromJSDate(sampleStoredUtc, { zone: "utc" }).plus({ hours: 1 }).toJSDate(),
      ownerTimezone,
    ),
  };
}

export function formatOwnerTimeDebug(debug: OwnerTimeDebug) {
  return [
    "Owner time debug",
    `ownerTimezone: ${debug.ownerTimezone}`,
    `serverTimezone: ${debug.serverTimezone}`,
    `currentUtc: ${debug.currentUtcTime}`,
    `currentOwnerLocal: ${debug.currentOwnerLocalTime}`,
    `sampleInput: ${debug.sampleInput}`,
    `sampleLocal: ${debug.sampleLocalIso}`,
    `sampleStoredUtc: ${debug.sampleStoredUtc}`,
    `sampleRendered: ${debug.sampleRendered}`,
  ].join("\n");
}

function nextFridayAt2130(nowLocal: DateTime) {
  const daysUntilFriday = (5 - nowLocal.weekday + 7) % 7 || 7;
  return nowLocal
    .plus({ days: daysUntilFriday })
    .set({ hour: 21, minute: 30, second: 0, millisecond: 0 });
}
