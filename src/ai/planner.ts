import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

import { heuristicBuildActionPlan } from "./heuristicActionPlanner";
import { canUseOpenAI, getOpenAIClient } from "./openaiClient";
import { validateActionPlan } from "./plan-validator";
import { buildPlannerInstructions } from "./prompts/planner.system";
import { actionPlanSchema, type ActionPlan } from "./schemas";
import { actionPlanTool } from "./tools";

export async function buildActionPlan(params: {
  text: string;
  timezone: string;
  now?: Date;
  activeContext?: string;
}): Promise<ActionPlan> {
  const now = params.now ?? new Date();

  if (!getEnv().ENABLE_AGENT_PLANNER_V2 || !canUseOpenAI()) {
    if (getEnv().OPENAI_REQUIRED_FOR_NATURAL_LANGUAGE) {
      throw new Error("OpenAI is required for natural-language planning");
    }
    return validateActionPlan({
      plan: heuristicBuildActionPlan({ ...params, now }),
      text: params.text,
      timezone: params.timezone,
      now,
    });
  }

  try {
    const client = getOpenAIClient();
    const response = await client.responses.create({
      model: getEnv().OPENAI_PLANNER_MODEL,
      instructions: buildPlannerInstructions({
        timezone: params.timezone,
        now,
        activeContext: params.activeContext,
      }),
      input: params.text,
      tools: [actionPlanTool] as never,
      tool_choice: { type: "function", name: "propose_action_plan" } as never,
      parallel_tool_calls: false,
      max_output_tokens: 3500,
    });

    const raw = extractToolArguments(response);
    if (!raw) throw new Error("OpenAI returned no action plan tool call");

    return validateActionPlan({
      plan: actionPlanSchema.parse(JSON.parse(raw)),
      text: params.text,
      timezone: params.timezone,
      now,
    });
  } catch (error) {
    if (getEnv().OPENAI_REQUIRED_FOR_NATURAL_LANGUAGE) throw error;
    logger.warn("Planner V2 fell back to deterministic heuristic", {
      error: error instanceof Error ? error.message : String(error),
    });
    return validateActionPlan({
      plan: heuristicBuildActionPlan({ ...params, now }),
      text: params.text,
      timezone: params.timezone,
      now,
    });
  }
}

function extractToolArguments(response: unknown): string | null {
  const output = (response as { output?: Array<Record<string, unknown>> }).output ?? [];
  const call = output.find(
    (item) => item.type === "function_call" && item.name === "propose_action_plan",
  );
  if (typeof call?.arguments === "string") return call.arguments;

  const outputText = (response as { output_text?: string }).output_text;
  if (outputText) return outputText;
  return null;
}
