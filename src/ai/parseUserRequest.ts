import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

import { buildAssistantInstructions } from "./assistantPrompt";
import { heuristicParseUserRequest } from "./heuristicParser";
import { canUseOpenAI, getOpenAIClient } from "./openaiClient";
import { plannerActionProposalSchema, type PlannerActionProposal } from "./schemas";
import { plannerActionTool } from "./tools";

export async function parseUserRequest(params: {
  text: string;
  timezone: string;
  now?: Date;
  memoryContext?: string;
}): Promise<PlannerActionProposal> {
  const now = params.now ?? new Date();

  if (!canUseOpenAI()) {
    if (getEnv().NODE_ENV === "production") {
      throw new Error("OPENAI_API_KEY is required in production");
    }
    return heuristicParseUserRequest({ text: params.text, timezone: params.timezone, now });
  }

  const client = getOpenAIClient();
  const response = await client.responses.create({
    model: getEnv().OPENAI_TEXT_MODEL,
    instructions: buildAssistantInstructions({
      timezone: params.timezone,
      now,
      memoryContext: params.memoryContext,
    }),
    input: params.text,
    tools: [plannerActionTool] as never,
    tool_choice: { type: "function", name: "propose_planner_action" } as never,
    parallel_tool_calls: false,
    max_output_tokens: 1200,
  });

  const raw = extractToolArguments(response);
  if (!raw) {
    logger.warn("OpenAI returned no planner tool call", { responseId: response.id });
    return {
      ...heuristicParseUserRequest({ text: params.text, timezone: params.timezone, now }),
      confidence: 0.3,
    };
  }

  return plannerActionProposalSchema.parse(JSON.parse(raw));
}

function extractToolArguments(response: unknown): string | null {
  const output = (response as { output?: Array<Record<string, unknown>> }).output ?? [];
  const call = output.find(
    (item) => item.type === "function_call" && item.name === "propose_planner_action",
  );
  if (typeof call?.arguments === "string") return call.arguments;

  const outputText = (response as { output_text?: string }).output_text;
  if (outputText) return outputText;
  return null;
}
