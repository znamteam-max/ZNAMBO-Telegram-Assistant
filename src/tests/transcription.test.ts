import { describe, expect, it } from "vitest";

import { OPENAI_TRANSCRIPTION_LIMIT_BYTES, transcribeMedia } from "@/ai/transcription";

describe("transcription guard", () => {
  it("rejects media above OpenAI transcription limit before API call", async () => {
    await expect(
      transcribeMedia({
        bytes: Buffer.alloc(OPENAI_TRANSCRIPTION_LIMIT_BYTES + 1),
        filename: "too-large.mp4",
        mimeType: "video/mp4",
      }),
    ).rejects.toThrow(/25 МБ/);
  });
});
