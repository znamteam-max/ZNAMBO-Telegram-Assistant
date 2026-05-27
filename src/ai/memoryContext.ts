import { listActiveMemories } from "@/db/queries/memories";

export async function buildMemoryContext(userId: string): Promise<string> {
  const memories = await listActiveMemories(userId, 12);
  if (!memories.length) return "";
  return memories
    .map((memory) => `- [${memory.category}] ${memory.content}`)
    .join("\n")
    .slice(0, 4000);
}
