import OpenAI from "openai";
import { z } from "zod";

import { getEnv } from "@/lib/env";

import { getOpenAIClient } from "./openaiClient";
import { agentExecutionSchema, type AgentExecution } from "./schemas/agentExecution";
import { actionPlanJsonSchema } from "./schemas";
import { normalizeAgentExecutionProposal } from "./agentExecutionNormalization";

export type AiCallTelemetry = {
  aiRequired: boolean;
  aiCalled: boolean;
  aiSucceeded: boolean;
  aiModel: string | null;
  openaiResponseId: string | null;
  requestStartedAt: string | null;
  requestFinishedAt: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  structuredOutputValid: boolean;
  toolCallsProposed: string[];
  errorCode: string | null;
  safeErrorMessage: string | null;
};

export class MandatoryAiError extends Error {
  constructor(
    message: string,
    public readonly telemetry: AiCallTelemetry,
  ) {
    super(message);
  }
}

const nullableActionPlanSchema = {
  anyOf: [{ type: "null" }, buildStrictAgentActionPlanSchema()],
} as const;

export const agentExecutionTool = {
  type: "function",
  name: "propose_agent_execution",
  description:
    "Choose and fully describe the exact tools the personal Telegram assistant must execute for this natural-language turn.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [
      "intent",
      "reply",
      "actionPlan",
      "viewScope",
      "resetMode",
      "itemUpdates",
      "reminderPolicies",
      "memoryFacts",
      "clarificationQuestions",
    ],
    properties: {
      intent: {
        type: "string",
        enum: [
          "create_plan",
          "update_existing_items",
          "render_view",
          "reset_active_plan",
          "cleanup_garbage",
          "store_memory",
          "reply",
          "clarify",
          "manage_reminder_policies",
        ],
      },
      reply: { type: ["string", "null"] },
      actionPlan: nullableActionPlanSchema,
      viewScope: {
        type: ["string", "null"],
        enum: [
          "full",
          "today",
          "tomorrow",
          "week",
          "tasks",
          "yesterday",
          "evening",
          "dashboard",
          "reminders",
          "longterm",
          null,
        ],
      },
      resetMode: { type: ["string", "null"], enum: ["all", "garbage", null] },
      itemUpdates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "itemIds",
            "operation",
            "startAtLocal",
            "endAtLocal",
            "reminderMinutesBefore",
            "followupMinutesAfter",
            "priority",
            "exposeManagementButtons",
            "note",
          ],
          properties: {
            itemIds: { type: "array", minItems: 1, items: { type: "string" } },
            operation: {
              type: "string",
              enum: ["configure", "complete", "reschedule"],
            },
            startAtLocal: { type: ["string", "null"] },
            endAtLocal: { type: ["string", "null"] },
            reminderMinutesBefore: { type: ["integer", "null"], minimum: 1 },
            followupMinutesAfter: { type: ["integer", "null"], minimum: 0 },
            priority: { type: ["integer", "null"], minimum: 1, maximum: 5 },
            exposeManagementButtons: { type: "boolean" },
            note: { type: ["string", "null"] },
          },
        },
      },
      reminderPolicies: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "operation",
            "itemIds",
            "itemTitle",
            "title",
            "category",
            "policyType",
            "startsAtLocal",
            "endsAtLocal",
            "nextFireAtLocal",
            "recurrenceRule",
            "intervalMinutes",
            "requireAck",
            "maxOccurrences",
            "minutesBefore",
            "windowEndInclusive",
            "catchUpMode",
            "onWindowEnd",
            "quietHoursStart",
            "quietHoursEnd",
            "allowDuringQuietHours",
          ],
          properties: {
            operation: {
              type: "string",
              enum: [
                "create_reminder_policy",
                "attach_reminder_policy_to_items",
                "create_interval_window_policy",
                "create_recurring_policy",
                "create_post_event_reaction_policy",
                "create_before_event_policy",
              ],
            },
            itemIds: { type: "array", items: { type: "string" } },
            itemTitle: { type: ["string", "null"] },
            title: { type: "string" },
            category: {
              type: "string",
              enum: [
                "today_focus",
                "event",
                "pre_event",
                "post_event",
                "task_deadline",
                "nag_until_done",
                "long_term",
                "recurring_home",
                "recurring_car",
                "recurring_finance",
                "health",
                "training",
                "content",
                "admin",
                "project",
                "someday",
                "urgent",
                "meeting",
                "car",
                "home",
                "finance",
                "documents",
                "people",
              ],
            },
            policyType: {
              type: "string",
              enum: [
                "one_time",
                "before_event",
                "after_event",
                "post_event_menu",
                "interval_window",
                "recurring",
                "nag_until_ack",
                "long_term",
              ],
            },
            startsAtLocal: { type: ["string", "null"] },
            endsAtLocal: { type: ["string", "null"] },
            nextFireAtLocal: { type: ["string", "null"] },
            recurrenceRule: { type: ["string", "null"] },
            intervalMinutes: { type: ["integer", "null"], minimum: 1 },
            requireAck: { type: "boolean" },
            maxOccurrences: { type: ["integer", "null"], minimum: 1 },
            minutesBefore: { type: ["integer", "null"], minimum: 1 },
            windowEndInclusive: { type: "boolean" },
            catchUpMode: {
              type: "string",
              enum: ["none", "latest_only", "one_immediate_then_resume"],
            },
            onWindowEnd: {
              type: "string",
              enum: ["expire_silently", "final_check", "carry_to_next_day"],
            },
            quietHoursStart: { type: ["string", "null"] },
            quietHoursEnd: { type: ["string", "null"] },
            allowDuringQuietHours: { type: "boolean" },
          },
        },
      },
      memoryFacts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["category", "content", "searchTags"],
          properties: {
            category: {
              type: "string",
              enum: ["preference", "project", "person", "routine", "meeting_pattern"],
            },
            content: { type: "string" },
            searchTags: { type: "array", items: { type: "string" } },
          },
        },
      },
      clarificationQuestions: { type: "array", items: { type: "string" } },
    },
  },
} as const;

export async function proposeAgentExecution(params: {
  text: string;
  timezone: string;
  now: Date;
  activeContext: string;
  preRouterIntent?: string | null;
}): Promise<{ execution: AgentExecution; telemetry: AiCallTelemetry }> {
  const model = getEnv().OPENAI_PLANNER_MODEL;
  const started = new Date();
  const telemetry = createTelemetry(model, started);
  telemetry.aiCalled = true;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await getOpenAIClient().responses.create({
        model,
        instructions: buildAgentInstructions(params),
        input: params.text,
        tools: [agentExecutionTool] as never,
        tool_choice: { type: "function", name: "propose_agent_execution" } as never,
        parallel_tool_calls: false,
        max_output_tokens: 5000,
      });
      finishTelemetry(telemetry, response);
      const call = response.output.find(
        (item) => item.type === "function_call" && item.name === "propose_agent_execution",
      ) as { arguments?: string } | undefined;
      if (!call || typeof call.arguments !== "string") {
        throw new SyntaxError("Missing required agent tool call");
      }
      const parsedExecution = agentExecutionSchema.parse(JSON.parse(call.arguments));
      const execution = normalizeAgentExecutionProposal({
        execution: parsedExecution,
        text: params.text,
        timezone: params.timezone,
        now: params.now,
        activeContext: params.activeContext,
      });
      telemetry.toolCallsProposed = inferExecutionTools(execution);
      telemetry.structuredOutputValid = true;
      telemetry.aiSucceeded = true;
      return { execution, telemetry };
    } catch (error) {
      if (isStructuredOutputError(error) && attempt < 2) continue;
      finishTelemetry(telemetry);
      const classified = classifyOpenAiError(error);
      telemetry.errorCode = classified.code;
      telemetry.safeErrorMessage = classified.safeMessage;
      throw new MandatoryAiError(classified.safeMessage, telemetry);
    }
  }

  throw new MandatoryAiError("OpenAI request failed safely.", telemetry);
}

function inferExecutionTools(execution: AgentExecution) {
  const tools: string[] = [];
  if (execution.actionPlan) tools.push("create_action_plan");
  if (execution.viewScope) tools.push(`render_${execution.viewScope}`);
  if (execution.resetMode) tools.push(`reset_active_plan:${execution.resetMode}`);
  if (execution.itemUpdates.length) tools.push("update_existing_items");
  if (execution.reminderPolicies.length) {
    tools.push(...new Set(execution.reminderPolicies.map((policy) => policy.operation)));
  }
  if (execution.memoryFacts.length) tools.push("store_memory");
  if (!tools.length) tools.push(execution.intent);
  return tools;
}

function buildAgentInstructions(params: {
  timezone: string;
  now: Date;
  activeContext: string;
  preRouterIntent?: string | null;
}) {
  return `Ты управляющий агент личного Telegram-ежедневника. Каждый ответ обязан быть tool-call propose_agent_execution.

Текущий UTC: ${params.now.toISOString()}
Часовой пояс: ${params.timezone}
Предварительный deterministic hint, не являющийся решением: ${params.preRouterIntent ?? "none"}

Правила:
- Сначала пойми намерение, затем предложи исполняемые инструменты. Не превращай инструкцию управления в новую задачу.
- Заголовки "На сегодня:", "На завтра:" и похожие перед непустым списком новых дел означают create_plan, а не render_view.
- render_view разрешён только при явном запросе показать существующий план: "покажи", "что у меня", "дай план", "какие задачи".
- Выбирай ровно один primary mutation path. При create_plan: actionPlan заполнен, resetMode=null, itemUpdates=[].
- viewScope может быть заполнен вместе с create_plan только если пользователь одновременно просит показать план после добавления. Это post-execution view, а не причина копировать существующие items.
- При update_existing_items: actionPlan=null, resetMode=null. При render_view без изменений: actionPlan=null и itemUpdates=[].
- Поля action metadata и reminder payload всегда возвращай как пустые объекты {}. Вся исполняемая семантика должна находиться в типизированных полях.
- Списки с конкретным временем классифицируй по смыслу: забег/эфир/встреча = event, тренировка/Z2 = training. Используй startAtLocal, не dueAtLocal 23:59.
- "Дедлайн", "срок", "сдать до", "успеть до", "завтра до 14:00" и аналогичные формулировки означают task с dueAtLocal. Не превращай дедлайн в startAtLocal/endAtLocal и не выдумывай блок от текущего времени до срока.
- Если явно названы и рабочий интервал, и дедлайн, сохрани оба: startAtLocal/endAtLocal для "с 10 до 12", dueAtLocal для "дедлайн до 14".
- Пример: "Сделать цитаты для эфира Больше, дедлайн завтра до 14.00" = kind=task, startAtLocal=null, endAtLocal=null, dueAtLocal=завтра 14:00.
- Если пользователь ссылается на "каждое событие", "их", "эти встречи", используй item IDs из контекста и intent=update_existing_items. Не создавай новый item из инструкции.
- Для настроек напоминаний используй operation=configure, startAtLocal=null, endAtLocal=null.
- Для "выполнено", "сделано", "поставь сделанным" используй operation=complete только для предмета текущего разговора. Если в контексте есть Latest delivered reminder/follow-up, используй только его item ID, а не все события дня.
- Для изменения времени используй operation=reschedule и ровно один update на item ID. Заполняй startAtLocal и endAtLocal полными локальными ISO datetime. Если пользователь меняет только окончание, сохрани существующее начало из контекста.
- Для "за час до каждого события" ставь reminderMinutesBefore=60 для всех подходящих item IDs.
- Для "после спроси как прошло" ставь followupMinutesAfter=15.
- Для кнопок удаления/переноса/редактирования ставь exposeManagementButtons=true.
- Для изменения приоритета существующего item используй operation=configure и priority=1..5.
- Новые независимые дела возвращай как actionPlan. Сохраняй каждое действие отдельно.
- В гибридном запросе "дай план на сегодня, добавь вечером подготовку к ЧМ дома" actionPlan должен содержать только новую "Подготовку к ЧМ"; существующие события из контекста нельзя повторять. Поставь viewScope=today, чтобы приложение показало итоговый план после сохранения.
- Просьбы показать план/задачи возвращай как render_view.
- Reset и cleanup возвращай отдельными intent, никогда как actionPlan.
- Не выдумывай item ID. Используй только ID из контекста.
- Если ссылку на существующие items нельзя разрешить, intent=clarify и задай короткий вопрос.
- Не обещай выполненное действие: приложение исполнит предложенные инструменты после валидации.

Обязательный пример:
USER: На сегодня:
* красочный забег в 10:00
* эфир ВС в 13:00
* тренировка Z2 в 22:00
RESULT: intent=create_plan; один actionPlan с тремя отдельными actions:
1) actionType=event, kind=event, title="Красочный забег", startAtLocal сегодня 10:00;
2) actionType=event, kind=event, title="Эфир ВС", startAtLocal сегодня 13:00;
3) actionType=training, kind=training, title="Тренировка Z2", startAtLocal сегодня 22:00.
У всех трёх dueAtLocal=null. Не выбирай render_today для такого сообщения.

USER после доставленного follow-up по item id=11111111-1111-4111-8111-111111111111:
Отлично! Выполнено, поставь это сделанным
RESULT: intent=update_existing_items; один itemUpdate только для этого ID; operation=complete; остальные поля изменения времени и напоминаний null.

USER: Дай план на сегодня, добавь вечером подготовку к ЧМ дома
RESULT: intent=create_plan; actionPlan содержит только новую подготовку к ЧМ; viewScope=today. Не включай в actionPlan уже существующие Эфир ВС или Тренировку Z2.

USER при существующем item id=22222222-2222-4222-8222-222222222222, Эфир ВС в 13:00:
Эфир ВС с 13 до 20 сделай
RESULT: intent=update_existing_items; один itemUpdate для этого ID; operation=reschedule; startAtLocal сегодня 13:00; endAtLocal сегодня 20:00.

Reminder policy rules:
- reminderPolicies всегда массив, даже если политик нет.
- Для "каждые полчаса", "каждый час", "пока не отмечу", weekly, biweekly и long-term создавай одну задачу в actionPlan и одну reminder policy. Не создавай пачку reminder items.
- Для окна повторов используй create_interval_window_policy, policyType=interval_window, startsAtLocal, endsAtLocal, intervalMinutes и requireAck.
- Для еженедельных и двухнедельных напоминаний используй create_recurring_policy, policyType=recurring или long_term и recurrenceRule=weekly/every_2_weeks.
- Для "за час до каждого события" используй create_before_event_policy для реальных item IDs, minutesBefore=60. Не создавай generic task.
- Для меню реакции после события используй create_post_event_reaction_policy, policyType=post_event_menu для каждого item ID.
- Для "не пиши ночью" используй quietHoursStart=00:00, quietHoursEnd=07:30. Для "можно ночью" ставь allowDuringQuietHours=true.
- Для interval policy по умолчанию catchUpMode=one_immediate_then_resume, windowEndInclusive=true и onWindowEnd=expire_silently.
- Для запросов показать живой план, напоминания или дальние записи используй viewScope=dashboard/reminders/longterm.

Контекст с реальными item IDs и последним task view:
${params.activeContext}`;
}

function createTelemetry(model: string, started: Date): AiCallTelemetry {
  return {
    aiRequired: true,
    aiCalled: false,
    aiSucceeded: false,
    aiModel: model,
    openaiResponseId: null,
    requestStartedAt: started.toISOString(),
    requestFinishedAt: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    structuredOutputValid: false,
    toolCallsProposed: [],
    errorCode: null,
    safeErrorMessage: null,
  };
}

function buildStrictAgentActionPlanSchema() {
  const schema = JSON.parse(JSON.stringify(actionPlanJsonSchema)) as {
    properties: {
      actions: {
        items: {
          properties: {
            metadata: Record<string, unknown>;
            reminders: {
              items: {
                properties: {
                  payload: Record<string, unknown>;
                };
              };
            };
          };
        };
      };
    };
  };
  schema.properties.actions.items.properties.metadata = {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {},
  };
  schema.properties.actions.items.properties.reminders.items.properties.payload = {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {},
  };
  return schema;
}

function finishTelemetry(
  telemetry: AiCallTelemetry,
  response?: {
    id?: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  },
) {
  const finished = new Date();
  telemetry.requestFinishedAt = finished.toISOString();
  telemetry.latencyMs = telemetry.requestStartedAt
    ? finished.getTime() - new Date(telemetry.requestStartedAt).getTime()
    : null;
  telemetry.openaiResponseId = response?.id ?? telemetry.openaiResponseId;
  telemetry.aiModel = response?.model ?? telemetry.aiModel;
  if (response?.usage) {
    telemetry.inputTokens = (telemetry.inputTokens ?? 0) + response.usage.input_tokens;
    telemetry.outputTokens = (telemetry.outputTokens ?? 0) + response.usage.output_tokens;
    telemetry.totalTokens = (telemetry.totalTokens ?? 0) + response.usage.total_tokens;
  }
}

export function classifyOpenAiError(error: unknown) {
  if (error instanceof OpenAI.AuthenticationError) {
    return { code: "authentication", safeMessage: "OpenAI authentication failed." };
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return {
      code: "network",
      safeMessage: "OpenAI is unavailable from the current region or project.",
    };
  }
  if (error instanceof OpenAI.RateLimitError) {
    return { code: "rate_limit", safeMessage: "OpenAI rate limit was reached." };
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return { code: "timeout", safeMessage: "OpenAI request timed out." };
  }
  if (error instanceof OpenAI.NotFoundError) {
    return { code: "invalid_model", safeMessage: "Configured OpenAI model is unavailable." };
  }
  if (error instanceof OpenAI.BadRequestError) {
    return { code: "schema", safeMessage: "OpenAI rejected the agent tool schema or request." };
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return { code: "network", safeMessage: "OpenAI network request failed." };
  }
  if (error instanceof SyntaxError || error instanceof z.ZodError) {
    return { code: "schema", safeMessage: "OpenAI returned invalid structured output." };
  }
  return { code: "unknown", safeMessage: "OpenAI request failed safely." };
}

function isStructuredOutputError(error: unknown) {
  return error instanceof SyntaxError || error instanceof z.ZodError;
}
