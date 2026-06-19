import { writeAudit } from "@/db/queries/audit";

export type MessageKind =
  | "reminder_alert"
  | "renag_alert"
  | "event_alert"
  | "dashboard_refresh"
  | "plan_manual"
  | "status_ack"
  | "cleanup_status"
  | "debug_output"
  | "release_notification"
  | "admin_output";

export type DeliverySoundMode = "loud_reminder" | "normal" | "silent_status";

type DeliveryPolicy = {
  deliverySoundMode: DeliverySoundMode;
  disableNotification: boolean;
};

const LOUD_KINDS = new Set<MessageKind>(["reminder_alert", "renag_alert", "event_alert"]);

export function getTelegramDeliveryPolicy(messageKind: MessageKind): DeliveryPolicy {
  if (LOUD_KINDS.has(messageKind)) {
    return { deliverySoundMode: "loud_reminder", disableNotification: false };
  }
  if (messageKind === "plan_manual") {
    return { deliverySoundMode: "silent_status", disableNotification: true };
  }
  return { deliverySoundMode: "silent_status", disableNotification: true };
}

export function withTelegramDeliveryPolicy<T extends Record<string, unknown>>(
  messageKind: MessageKind,
  options: T = {} as T,
): T & { disable_notification: boolean } {
  const policy = getTelegramDeliveryPolicy(messageKind);
  return {
    ...options,
    disable_notification: policy.disableNotification,
  };
}

export async function auditTelegramDelivery(params: {
  userId: string;
  messageKind: MessageKind;
  entityType?: string;
  entityId?: string | null;
  targetItemId?: string | null;
  targetPolicyId?: string | null;
  targetReminderId?: string | null;
  details?: Record<string, unknown>;
}) {
  const policy = getTelegramDeliveryPolicy(params.messageKind);
  await Promise.resolve(
    writeAudit({
      userId: params.userId,
      action: "assistant.telegram_send_mode",
      entityType: params.entityType ?? "telegram_message",
      entityId: params.entityId ?? null,
      details: {
        messageKind: params.messageKind,
        deliverySoundMode: policy.deliverySoundMode,
        disableNotification: policy.disableNotification,
        targetItemId: params.targetItemId ?? null,
        targetPolicyId: params.targetPolicyId ?? null,
        targetReminderId: params.targetReminderId ?? null,
        ...(params.details ?? {}),
      },
    }),
  ).catch(() => undefined);
}
