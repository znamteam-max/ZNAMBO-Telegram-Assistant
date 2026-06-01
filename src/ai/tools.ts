import { actionPlanJsonSchema, plannerActionJsonSchema } from "./schemas";

export const plannerActionTool = {
  type: "function",
  name: "propose_planner_action",
  description:
    "Return one proposed action for the personal Telegram planning assistant. The app will save nothing until the owner confirms.",
  parameters: plannerActionJsonSchema,
  strict: true,
} as const;

export const actionPlanTool = {
  type: "function",
  name: "propose_action_plan",
  description:
    "Return a multi-action plan for a smart personal Telegram planner. Extract all events, tasks, preparation, tentative events, trainings, recurring reminders, and memory facts from one message.",
  parameters: actionPlanJsonSchema,
  strict: true,
} as const;
