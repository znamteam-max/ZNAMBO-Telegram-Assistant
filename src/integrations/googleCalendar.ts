import { google } from "googleapis";

import {
  getGoogleCalendarConnection,
  getItemGoogleSyncState,
  markGoogleCalendarSync,
  upsertGoogleCalendarConnection,
} from "@/db/queries/googleCalendar";
import { getUserByTelegramId } from "@/db/queries/users";
import type { PlannerItem } from "@/db/schema";
import { getEnv, isGoogleCalendarConfigured, requireEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createSignedState, verifySignedState } from "@/lib/secrets";

import { decryptSecret, encryptSecret } from "./encryption";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export type CalendarSyncResult =
  | { status: "disabled" | "skipped" }
  | { status: "synced"; externalId: string }
  | { status: "error"; error: string };

type OAuthState = {
  telegramUserId: string;
  issuedAt: number;
};

function getOAuthClient() {
  const env = getEnv();
  return new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    env.GOOGLE_REDIRECT_URI,
  );
}

export function createGoogleCalendarAuthUrl(telegramUserId: string): string {
  if (!isGoogleCalendarConfigured()) {
    throw new Error("Google Calendar OAuth is not configured");
  }
  const state = createSignedState(
    { telegramUserId, issuedAt: Date.now() } satisfies OAuthState,
    requireEnv("APP_ENCRYPTION_KEY"),
  );
  return getOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [CALENDAR_SCOPE],
    state,
  });
}

export async function finishGoogleCalendarOAuth(params: { code: string; state: string }) {
  const state = verifySignedState<OAuthState>(params.state, requireEnv("APP_ENCRYPTION_KEY"));
  if (!state || Date.now() - state.issuedAt > 15 * 60 * 1000) {
    throw new Error("Invalid or expired OAuth state");
  }

  const user = await getUserByTelegramId(state.telegramUserId);
  if (!user) throw new Error("Owner user not found for OAuth state");

  const oauthClient = getOAuthClient();
  const { tokens } = await oauthClient.getToken(params.code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return refresh token. Reconnect with prompt=consent.");
  }

  oauthClient.setCredentials(tokens);
  let googleEmail: string | null = null;
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: oauthClient });
    const profile = await oauth2.userinfo.get();
    googleEmail = profile.data.email ?? null;
  } catch (error) {
    logger.warn("Could not fetch Google userinfo", { error: String(error) });
  }

  const connection = await upsertGoogleCalendarConnection({
    userId: user.id,
    googleEmail,
    calendarId: getEnv().GOOGLE_CALENDAR_ID,
    encryptedRefreshToken: encryptSecret(tokens.refresh_token),
    accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  });

  return { user, connection };
}

export async function syncPlannerItemToGoogle(item: PlannerItem): Promise<CalendarSyncResult> {
  if (!isGoogleCalendarConfigured()) return { status: "disabled" };
  if (item.kind !== "event" && item.kind !== "training") return { status: "skipped" };
  if (!item.startAt) return { status: "skipped" };

  const connection = await getGoogleCalendarConnection(item.userId);
  if (!connection || connection.status !== "connected") return { status: "disabled" };

  try {
    const auth = getOAuthClient();
    auth.setCredentials({ refresh_token: decryptSecret(connection.encryptedRefreshToken) });

    const calendar = google.calendar({ version: "v3", auth });
    const existingSync = await getItemGoogleSyncState(item.id);
    const event = {
      summary: item.title,
      description: item.description ?? undefined,
      location: item.location ?? undefined,
      start: {
        dateTime: item.startAt.toISOString(),
        timeZone: item.timezone,
      },
      end: {
        dateTime: (item.endAt ?? new Date(item.startAt.getTime() + 60 * 60 * 1000)).toISOString(),
        timeZone: item.timezone,
      },
    };

    if (existingSync?.externalId) {
      const response = await calendar.events.update({
        calendarId: connection.calendarId,
        eventId: existingSync.externalId,
        requestBody: event,
      });
      const externalId = response.data.id ?? existingSync.externalId;
      await markGoogleCalendarSync({ item, externalId, status: "synced" });
      return { status: "synced", externalId };
    }

    const response = await calendar.events.insert({
      calendarId: connection.calendarId,
      requestBody: event,
    });
    const externalId = response.data.id;
    if (!externalId) throw new Error("Google Calendar did not return event id");

    await markGoogleCalendarSync({ item, externalId, status: "synced" });
    return { status: "synced", externalId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markGoogleCalendarSync({ item, status: "error", lastError: message });
    logger.warn("Google Calendar sync failed", { itemId: item.id, error: message });
    return { status: "error", error: message };
  }
}
