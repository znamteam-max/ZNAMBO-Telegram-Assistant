import { cleanupPreviewKeyboard } from "@/bot/keyboards";
import { listActiveMessages } from "@/db/queries/telegramMessageRegistry";

const TRANSIENT_PURPOSES = [
  "item_menu",
  "reminder",
  "followup",
  "confirmation",
  "transient_status",
  "policy_editor",
];

export async function renderCleanupPreview(params: {
  userId: string;
  chatId: string;
}) {
  const transient = await listActiveMessages({
    userId: params.userId,
    chatId: params.chatId,
    purposes: TRANSIENT_PURPOSES,
    limit: 200,
  });
  const lines = [
    "🧹 Очистка",
    "",
    "Ничего не удаляю без подтверждения.",
    "",
    `1. Карточки и временные сообщения в этом чате: ${transient.length}`,
    "2. Данные плана, задачи и Яндекс.Календарь: 0 изменений",
    "",
    "Выбери preview или явное подтверждение.",
  ];
  return {
    text: lines.join("\n"),
    keyboard: cleanupPreviewKeyboard(params.chatId),
    transientCount: transient.length,
  };
}
