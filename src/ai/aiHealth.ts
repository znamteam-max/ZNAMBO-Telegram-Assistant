import { z } from "zod";

import { getEnv } from "@/lib/env";

import { classifyOpenAiError, type AiCallTelemetry } from "./agentExecution";
import { getOpenAIClient } from "./openaiClient";

const healthResultSchema = z.object({
  connected: z.literal(true),
  toolCalling: z.literal(true),
});

const healthTool = {
  type: "function",
  name: "report_ai_health",
  description: "Return a harmless OpenAI connectivity and tool-calling health result.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["connected", "toolCalling"],
    properties: {
      connected: { type: "boolean", enum: [true] },
      toolCalling: { type: "boolean", enum: [true] },
    },
  },
} as const;

export async function runOpenAiHealthCheck(): Promise<AiCallTelemetry> {
  const model = getEnv().OPENAI_PLANNER_MODEL;
  const started = new Date();
  const telemetry: AiCallTelemetry = {
    aiRequired: true,
    aiCalled: true,
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

  try {
    const response = await getOpenAIClient().responses.create({
      model,
      instructions:
        "Call report_ai_health exactly once. This is a harmless connectivity test. Do not produce normal text.",
      input: "Check API connectivity, strict structured output, and function tool availability.",
      tools: [healthTool] as never,
      tool_choice: { type: "function", name: "report_ai_health" } as never,
      parallel_tool_calls: false,
      max_output_tokens: 100,
    });
    finish(telemetry, response);
    const call = response.output.find(
      (item) => item.type === "function_call" && item.name === "report_ai_health",
    ) as { arguments?: string } | undefined;
    if (!call || typeof call.arguments !== "string") throw new Error("schema");
    healthResultSchema.parse(JSON.parse(call.arguments));
    telemetry.toolCallsProposed = ["report_ai_health"];
    telemetry.structuredOutputValid = true;
    telemetry.aiSucceeded = true;
    return telemetry;
  } catch (error) {
    finish(telemetry);
    const classified =
      error instanceof Error && error.message === "schema"
        ? { code: "schema", safeMessage: "OpenAI health structured output was invalid." }
        : classifyOpenAiError(error);
    telemetry.errorCode = classified.code;
    telemetry.safeErrorMessage = classified.safeMessage;
    return telemetry;
  }
}

function finish(
  telemetry: AiCallTelemetry,
  response?: {
    id?: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  },
) {
  const finished = new Date();
  telemetry.requestFinishedAt = finished.toISOString();
  telemetry.latencyMs = finished.getTime() - new Date(telemetry.requestStartedAt ?? finished).getTime();
  telemetry.openaiResponseId = response?.id ?? telemetry.openaiResponseId;
  telemetry.aiModel = response?.model ?? telemetry.aiModel;
  telemetry.inputTokens = response?.usage?.input_tokens ?? telemetry.inputTokens;
  telemetry.outputTokens = response?.usage?.output_tokens ?? telemetry.outputTokens;
  telemetry.totalTokens = response?.usage?.total_tokens ?? telemetry.totalTokens;
}
