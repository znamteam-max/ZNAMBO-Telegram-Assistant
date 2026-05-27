import { describe, expect, it } from "vitest";

import { getCalendarProvider, isYandexCalendarConfigured, resetEnvCacheForTests } from "@/lib/env";

describe("calendar environment", () => {
  it("selects Yandex only when CalDAV credentials are configured", () => {
    process.env.CALENDAR_PROVIDER = "yandex";
    resetEnvCacheForTests();
    expect(getCalendarProvider()).toBe("none");

    process.env.YANDEX_CALDAV_USERNAME = "owner@example.com";
    process.env.YANDEX_CALDAV_APP_PASSWORD = "app-password";
    resetEnvCacheForTests();

    expect(isYandexCalendarConfigured()).toBe(true);
    expect(getCalendarProvider()).toBe("yandex");
  });
});
