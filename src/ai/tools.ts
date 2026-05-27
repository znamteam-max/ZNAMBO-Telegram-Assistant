import { plannerActionJsonSchema } from "./schemas";

export const plannerActionTool = {
  type: "function",
  name: "propose_planner_action",
  description:
    "Return one proposed action for the personal Telegram planning assistant. The app will save nothing until the owner confirms.",
  parameters: plannerActionJsonSchema,
  strict: true,
} as const;
