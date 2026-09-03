import { InlineKeyboard } from "grammy";

/**
 * Hotfix keyboard for reminder schedule selection.
 *
 * The legacy `every_2_weeks` callback exceeds Telegram's 64-byte callback_data limit
 * when combined with a UUID item id, causing the entire keyboard send to fail with
 * BUTTON_DATA_INVALID. Keep only callback values that are within the hard limit;
 * custom cadence remains available through the custom rule path.
 */
export function stabilityScheduleReminderMenuKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("Каждый день", `policy_schedule:${itemId}:daily`)
    .text("По будням", `policy_schedule:${itemId}:weekdays`)
    .row()
    .text("Раз в неделю", `policy_schedule:${itemId}:weekly`)
    .text("Раз в месяц", `policy_schedule:${itemId}:monthly`)
    .row()
    .text("Раз в год", `policy_schedule:${itemId}:yearly`)
    .text("Своё правило", `policy_menu:custom:${itemId}`)
    .row()
    .text("🔙 Назад", `policy_menu:root:${itemId}`);
}
