import type { AgentTask } from "./state";
import { formatTaskDuration, taskElapsedMs } from "./timer";

export interface SessionRailContent {
  status: string;
  timer: string;
  title: string;
}

/** Compact semantic rail copy with timer kept in its own non-truncating region. */
export function sessionRailContent(task: AgentTask, now = Date.now()): SessionRailContent {
  const state = task.state === "working" ? "Working"
    : task.state === "thinking" ? "Thinking"
    : task.state === "searching" ? "Researching"
    : task.state === "approval" ? "Needs approval"
    : task.state === "finished" ? "Finished"
    : task.state === "interrupted" ? "Stopped"
    : task.state === "error" ? "Error"
    : task.state === "question" ? "Needs input"
    : task.state === "ratelimit" ? "Rate limited"
    : "Connected";
  const timer = formatTaskDuration(taskElapsedMs(task, now));
  const semantic = task.state === "approval" ? state
    : task.hasStructuredPlan && task.totalPlanCount
      ? `${task.completedPlanCount}/${task.totalPlanCount} · ${task.state === "finished" || task.state === "error" ? state : task.currentStatus || state}`
      : task.currentStatus && !["Connected", "Plan complete"].includes(task.currentStatus) ? task.currentStatus : state;
  return { status: semantic, timer, title: [task.name, semantic, timer].filter(Boolean).join(" · ") };
}
