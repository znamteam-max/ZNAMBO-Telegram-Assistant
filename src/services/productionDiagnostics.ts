import { sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { listLegacyReminderLikeItems } from "@/db/queries/items";
import { listActiveReminderPolicies } from "@/db/queries/reminderPolicies";
import { APP_VERSION } from "@/lib/version";
import { getCalendarStatus } from "@/services/calendarDiagnostics";
import { buildUserTimelineView } from "@/services/userTimeline";
import { previewV252ProductionRepair } from "@/services/v252ProductionRepair";

export async function getProductionStateV252(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const [statusRows, timeline, policies, legacy, calendar, repair] = await Promise.all([
    getDb().execute(sql`
      select status, count(*)::int as count
      from "assistant"."planner_items"
      where user_id = ${params.userId}::uuid
      group by status
      order by status
    `),
    buildUserTimelineView(params),
    listActiveReminderPolicies(params.userId, 300),
    listLegacyReminderLikeItems(params.userId, 300),
    getCalendarStatus(params.userId),
    previewV252ProductionRepair(params),
  ]);
  const plannerItemCountsByStatus = Object.fromEntries(
    statusRows.map((row) => [String(row.status), Number(row.count)]),
  );
  const plannerItemCountsByDateBucket = Object.fromEntries(
    Object.entries(timeline.byBucket).map(([bucket, rows]) => [bucket, rows.length]),
  );
  return {
    appVersion: APP_VERSION,
    deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    plannerItemCountsByStatus,
    plannerItemCountsByDateBucket,
    activeReminderPolicyCount: policies.length,
    orphanReminderLikeItemsCount: legacy.length,
    calendarProvider: calendar.provider,
    calendarConfigured: calendar.configured,
    calendarLastWriteStatus: calendar.lastWriteStatus,
    calendarLastWriteErrorClass: calendar.lastWriteErrorClass,
    dirtyDataCandidates: {
      orthodontist: repair.orthodontistItems.length,
      drik: repair.drikOrphans.length,
      oldOverdue: repair.oldOverdueItems.length,
      malformed: repair.v251.malformedItems.length,
      staleBotCards: repair.staleBotCards.length,
    },
  };
}
