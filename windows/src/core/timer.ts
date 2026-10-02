import type { AgentTask } from "./state";

function clockNow(): number {
  const preview = (globalThis as typeof globalThis & { __COUCOU_PREVIEW_NOW?: number }).__COUCOU_PREVIEW_NOW;
  return preview ?? Date.now();
}

export function taskElapsedMs(task: Pick<AgentTask, "taskStartedAt" | "taskFinishedAt">, now = clockNow()): number | null {
  if (task.taskStartedAt == null) return null;
  return Math.max(0, (task.taskFinishedAt ?? now) - task.taskStartedAt);
}

export function formatTaskDuration(elapsedMs: number | null): string {
  if (elapsedMs == null) return "";
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const ss = seconds % 60;
  return hh > 0
    ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
