import { describe, expect, it } from "vitest";

import { eventReactionKeyboard, reminderActionKeyboard } from "@/bot/keyboards";

describe("reminder action keyboard", () => {
  it("exposes repeat-until-ack controls", () => {
    const reminderId = "11111111-1111-4111-8111-111111111111";
    const itemId = "22222222-2222-4222-8222-222222222222";
    const keyboard = reminderActionKeyboard(reminderId, itemId);
    const texts = keyboard.inline_keyboard.flat().map((button) => button.text);

    expect(texts).toEqual([
      "✅ Выполнено сейчас",
      "😴 Через 30 мин",
      "😴 Через 1 час",
      "😴 Через 2 часа",
      "😴 Завтра",
      "✏️ Изменить правило",
      "🔕 Остановить правило",
      "⬅️ К плану",
    ]);
    for (const button of keyboard.inline_keyboard.flat()) {
      expect(Buffer.byteLength(button.callback_data ?? "", "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("offers an event reaction menu instead of a single how-did-it-go question", () => {
    const keyboard = eventReactionKeyboard("event-id", "event");
    const texts = keyboard.inline_keyboard.flat().map((button) => button.text);

    expect(texts).toEqual([
      "✅ Завершено",
      "❌ Отменить",
      "⏭ Перенести",
      "📝 Итоги",
      "✏️ Изменить",
      "🔙 План",
    ]);
  });
});
