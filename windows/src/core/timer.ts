import type { AgentTask } from "./state";

function clockNow(): number {
  const preview = (globalThis as typeof globalThis & { __COUCOU_PREVIEW_NOW?: number }).__COUCOU_PREVIEW_NOW;
  return preview ?? Date.now();
}

export function taskElapsedMs(task: Pick<AgentTask, "taskStartedAt" | "taskFinishedAt"> & Partial<Pick<AgentTask, "goalStartedAt" | "goalActive">>, now = clockNow()): number | null {
  if (task.goalActive && task.goalStartedAt != null) return Math.max(0, now - task.goalStartedAt);
  if (task.taskStartedAt == null) return null;
  return Math.max(0, (task.taskFinishedAt ?? now) - task.taskStartedAt);
}

export function formatTaskDuration(elapsedMs: number | null): string {
  if (elapsedMs == null || !Number.isFinite(elapsedMs)) return "";
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const minutePart = minutes % 60;
  const secondPart = seconds % 60;
  if (seconds < 60) return `${seconds}s`;
  if (hours > 0) return `${hours}h ${String(minutePart).padStart(2, "0")}m`;
  return `${minutes}m ${secondPart}s`;
}

/** Compact identity never substitutes the project/provider name for task intent. */
export function compactTaskTitle(title: string | null | undefined): string {
  const clean = title?.trim();
  return clean && clean.toLowerCase() !== "codex" ? clean : "Starting task";
}
