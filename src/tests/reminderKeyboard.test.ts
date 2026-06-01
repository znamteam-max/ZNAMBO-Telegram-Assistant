import { describe, expect, it } from "vitest";

import { reminderActionKeyboard } from "@/bot/keyboards";

describe("reminder action keyboard", () => {
  it("exposes repeat-until-ack controls", () => {
    const keyboard = reminderActionKeyboard("reminder-id", "item-id");
    const texts = keyboard.inline_keyboard.flat().map((button) => button.text);

    expect(texts).toEqual([
      "Готово на сегодня",
      "Напомни через час",
      "Пропустить сегодня",
      "Больше не напоминать",
    ]);
  });
});
