import { parseUpdatePlan } from "./plan";
import type { PlanStep } from "./state";

export interface ProgressUpdate {
  taskTitle?: string;
  currentStatus?: string;
  steps?: PlanStep[];
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

/** Parse the optional MCP metadata and the backward-compatible checklist. */
export function parseProgressUpdate(input: unknown): ProgressUpdate | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const title = cleanText(value.task_title ?? value.taskTitle, 96);
  const status = cleanText(value.current_status ?? value.currentStatus ?? value.message, 120);
  const steps = parseUpdatePlan({ steps: value.steps });
  if (!title && !status && !steps) return null;
  return { ...(title ? { taskTitle: title } : {}), ...(status ? { currentStatus: status } : {}), ...(steps ? { steps } : {}) };
}
