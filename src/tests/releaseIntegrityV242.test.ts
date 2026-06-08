import { describe, expect, it } from "vitest";

import {
  APP_VERSION,
  INTERVAL_ALGORITHM_VERSION,
  POLICY_ENGINE_VERSION,
  RECONCILER_ENABLED,
  RUNNER_LOCK_ENABLED,
} from "@/lib/version";

describe("V2.4.2 release integrity constants", () => {
  it("reports the active scheduler and interval implementation versions", () => {
    expect(APP_VERSION).toBe("2.4.2");
    expect(POLICY_ENGINE_VERSION).toBe("2.4.2");
    expect(INTERVAL_ALGORITHM_VERSION).toBe("anchor-grid-v2");
    expect(RECONCILER_ENABLED).toBe(true);
    expect(RUNNER_LOCK_ENABLED).toBe(true);
  });
});
