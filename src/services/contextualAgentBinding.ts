import type { AgentExecution } from "@/ai/schemas/agentExecution";

export function bindContextualCompletionTarget(params: {
  execution: AgentExecution;
  text: string;
  latestFollowupItemId: string | null;
}) {
  if (!params.latestFollowupItemId || !isGenericCompletionReply(params.text)) {
    return { execution: params.execution, warnings: [] as string[] };
  }
  const completeUpdates = params.execution.itemUpdates.filter(
    (update) => update.operation === "complete",
  );
  if (!completeUpdates.length) {
    return { execution: params.execution, warnings: [] as string[] };
  }
  const nonCompleteUpdates = params.execution.itemUpdates.filter(
    (update) => update.operation !== "complete",
  );
  const template = completeUpdates[0];
  return {
    execution: {
      ...params.execution,
      itemUpdates: [
        ...nonCompleteUpdates,
        {
          ...template,
          itemIds: [params.latestFollowupItemId],
        },
      ],
    },
    warnings: ["contextual_completion_bound_to_latest_followup"],
  };
}

function isGenericCompletionReply(text: string) {
  return /(выполнено|сделано|готово|поставь\s+это\s+сделанным|отметь\s+это\s+выполненным)/i.test(
    text,
  );
}
