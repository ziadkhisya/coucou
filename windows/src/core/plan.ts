import type { PlanStep, PlanStepStatus } from "./state";

const MAX_STEPS = 20;
const MAX_TEXT = 240;

/**
 * Adapt the update_plan input carried by a Codex PreToolUse hook into Coucou's
 * session plan. Codex CLI 0.159.2 ships an app-server
 * TurnPlanUpdatedNotification shape (`plan: [{ step, status }]`), though
 * probe sessions here did not emit one. Also accept common hook-input
 * envelopes, while rejecting malformed events without throwing.
 */
export function parseUpdatePlan(input: unknown): PlanStep[] | null {
  try {
    const root = asRecord(input);
    if (!root) return null;
    const plan = asRecord(root.plan);
    const candidate = Array.isArray(root.steps) ? root.steps
      : Array.isArray(plan?.steps) ? plan.steps
      : Array.isArray(root.plan) ? root.plan
      : null;
    if (!candidate || candidate.length === 0 || candidate.length > MAX_STEPS) return null;

    const parsed: PlanStep[] = [];
    for (const item of candidate) {
      const row = asRecord(item);
      if (!row) return null;
      const text = typeof row.text === "string" ? row.text
        : typeof row.step === "string" ? row.step
        : typeof row.title === "string" ? row.title
        : null;
      const status = normalizeStatus(row.status ?? row.state);
      if (!text?.trim() || !status) return null;
      parsed.push({ text: text.trim().slice(0, MAX_TEXT), status });
    }
    return parsed;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeStatus(value: unknown): PlanStepStatus | null {
  if (typeof value !== "string") return null;
  switch (value.replace(/[ _-]/g, "").toLowerCase()) {
    case "completed":
    case "complete":
    case "done": return "completed";
    case "inprogress":
    case "active": return "in_progress";
    case "pending":
    case "upcoming":
    case "notstarted": return "pending";
    default: return null;
  }
}
