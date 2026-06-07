import OpenAI from "openai";
import { z } from "zod";

import { getEnv } from "@/lib/env";

import { getOpenAIClient } from "./openaiClient";
import { agentExecutionSchema, type AgentExecution } from "./schemas/agentExecution";
import { actionPlanJsonSchema } from "./schemas";

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
  anyOf: [{ type: "null" }, actionPlanJsonSchema],
} as const;

export const agentExecutionTool = {
  type: "function",
  name: "propose_agent_execution",
  description:
    "Choose and fully describe the exact tools the personal Telegram assistant must execute for this natural-language turn.",
  // ActionPlan intentionally supports open-ended metadata and reminder payloads.
  // Runtime Zod validation remains mandatory after the forced function call.
  strict: false,
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
        ],
      },
      reply: { type: ["string", "null"] },
      actionPlan: nullableActionPlanSchema,
      viewScope: {
        type: ["string", "null"],
        enum: ["full", "today", "tomorrow", "week", "tasks", "yesterday", "evening", null],
      },
      resetMode: { type: ["string", "null"], enum: ["all", "garbage", null] },
      itemUpdates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "itemIds",
            "reminderMinutesBefore",
            "followupMinutesAfter",
            "exposeManagementButtons",
            "note",
          ],
          properties: {
            itemIds: { type: "array", minItems: 1, items: { type: "string" } },
            reminderMinutesBefore: { type: ["integer", "null"], minimum: 1 },
            followupMinutesAfter: { type: ["integer", "null"], minimum: 0 },
            exposeManagementButtons: { type: "boolean" },
            note: { type: ["string", "null"] },
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
      telemetry.errorCode = "schema";
      telemetry.safeErrorMessage = "OpenAI did not return the required agent tool call.";
      throw new MandatoryAiError(telemetry.safeErrorMessage, telemetry);
    }
    const execution = agentExecutionSchema.parse(JSON.parse(call.arguments));
    telemetry.toolCallsProposed = inferExecutionTools(execution);
    telemetry.structuredOutputValid = true;
    telemetry.aiSucceeded = true;
    return { execution, telemetry };
  } catch (error) {
    if (error instanceof MandatoryAiError) throw error;
    finishTelemetry(telemetry);
    const classified = classifyOpenAiError(error);
    telemetry.errorCode = classified.code;
    telemetry.safeErrorMessage = classified.safeMessage;
    throw new MandatoryAiError(classified.safeMessage, telemetry);
  }
}

function inferExecutionTools(execution: AgentExecution) {
  const tools: string[] = [];
  if (execution.actionPlan) tools.push("create_action_plan");
  if (execution.viewScope) tools.push(`render_${execution.viewScope}`);
  if (execution.resetMode) tools.push(`reset_active_plan:${execution.resetMode}`);
  if (execution.itemUpdates.length) tools.push("update_existing_items");
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
- Выбирай ровно один primary path. При create_plan: actionPlan заполнен, viewScope=null, resetMode=null, itemUpdates=[].
- При update_existing_items: actionPlan=null, viewScope=null, resetMode=null. При render_view: actionPlan=null и itemUpdates=[].
- Списки с конкретным временем классифицируй по смыслу: забег/эфир/встреча = event, тренировка/Z2 = training. Используй startAtLocal, не dueAtLocal 23:59.
- Если пользователь ссылается на "каждое событие", "их", "эти встречи", используй item IDs из контекста и intent=update_existing_items. Не создавай новый item из инструкции.
- Для "за час до каждого события" ставь reminderMinutesBefore=60 для всех подходящих item IDs.
- Для "после спроси как прошло" ставь followupMinutesAfter=15.
- Для кнопок удаления/переноса/редактирования ставь exposeManagementButtons=true.
- Новые независимые дела возвращай как actionPlan. Сохраняй каждое действие отдельно.
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
  telemetry.inputTokens = response?.usage?.input_tokens ?? telemetry.inputTokens;
  telemetry.outputTokens = response?.usage?.output_tokens ?? telemetry.outputTokens;
  telemetry.totalTokens = response?.usage?.total_tokens ?? telemetry.totalTokens;
}

export function classifyOpenAiError(error: unknown) {
  if (error instanceof OpenAI.AuthenticationError) {
    return { code: "authentication", safeMessage: "OpenAI authentication failed." };
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return { code: "network", safeMessage: "OpenAI is unavailable from the current region or project." };
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
