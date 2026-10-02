import "../src/style.css";
import { Island } from "../src/island/island";
import { State, type AgentTask } from "../src/core/state";
import { parseUpdatePlan } from "../src/core/plan";

const previewNow = Date.UTC(2026, 9, 2, 12, 0, 0);
(globalThis as typeof globalThis & { __COUCOU_PREVIEW_NOW?: number }).__COUCOU_PREVIEW_NOW = previewNow;
const island = new Island(document.getElementById("root")!);
// Keep the gallery state open while inspecting variants; production keeps the normal auto-close delay.
island.fsm.homeToPetitDelay = 3600;
const projectNames = ["DropshiFlow", "Coucou Windows", "Research workspace", "Personal site"];
const colors = ["#35A67A", "#60A5FA", "#F29B38", "#A78BFA"];

function session(index: number, name = projectNames[index % projectNames.length], state: AgentTask["state"] = "working"): AgentTask {
  const steps = index === 0
    ? ["Reading src/core/state.ts", "Running npm test", "Updating Codex overview layout"]
    : ["Reading project files", "Running a command"];
  return {
    id: `preview-codex-${index}`,
    name,
    color: colors[index % colors.length],
    state,
    stepIndex: steps.length - 1,
    stepRevision: steps.length,
    activityOrder: index,
    steps,
    planSteps: [],
    hasStructuredPlan: false,
    completedPlanCount: 0,
    totalPlanCount: 0,
    taskTitle: "Improve progress visibility",
    currentStatus: "Reviewing project files",
    lastSemanticMessage: "Reviewing project files",
    taskStartedAt: previewNow - (index === 2 ? 4_053_000 : 1_122_000),
    taskFinishedAt: state === "finished" ? previewNow - 5_000 : null,
    source: "codex",
    isIntegration: false,
    provider: "codex",
    sessionId: `preview-${index}`,
    pillBadge: state === "finished" ? "finished" : state === "approval" ? "approval" : null,
    sessionCwd: `C:\\Users\\lakhs\\Projects\\${name}`,
  };
}

const longName = "Coucou Personal Workflow and Windows Codex Integration Monorepo";
const defaultPlan = [
  { text: "Inspect the existing implementation", status: "completed" as const },
  { text: "Add structured Codex plan event handling", status: "completed" as const },
  { text: "Replace the activity ticker with semantic progress", status: "in_progress" as const },
  { text: "Build the updated Windows app", status: "pending" as const },
  { text: "Validate the installed version", status: "pending" as const },
];
let updateTimer: number | undefined;

const previewStates = new Set(["five", "one", "usage", "low", "mixed", "stale", "unavailable", "overhour", "longtitle", "long", "longplan", "taskchange", "newtask", "finished", "two", "many", "rail", "update", "approval", "longpermission", "collapsedactive", "collapsedplan"]);

function show(kind: string, writeHistory = true) {
  if (!previewStates.has(kind)) kind = "five";
  if (writeHistory) history.pushState({ coucouPreview: kind }, "", `?state=${encodeURIComponent(kind)}`);
  const active = kind === "two" ? [session(0), session(1)]
    : kind === "many" ? [session(0), session(1), session(2), session(3)]
    : kind === "rail" ? [session(0), session(1, longName), session(2, "Build and validation workspace", "thinking"), session(3, "Design system", "finished"), session(4, "Release validation", "working"), session(5, "Long-running docs and packaging check", "thinking")]
    : kind === "long" ? [session(0, longName)]
    : kind === "longtitle" ? [session(0)]
    : kind === "overhour" ? [session(0)]
    : kind === "finished" ? [session(0, "DropshiFlow", "finished")]
    : kind === "approval" ? [session(0, "DropshiFlow", "approval")]
    : [session(0)];

  if (kind === "five" || kind === "update") {
    active[0].planSteps = defaultPlan.map((step) => ({ ...step }));
    active[0].hasStructuredPlan = true;
    active[0].completedPlanCount = 2;
    active[0].totalPlanCount = 5;
    active[0].currentStatus = "Redesigning progress visibility";
  } else if (kind === "longplan") {
    active[0].planSteps = parseUpdatePlan({ steps: [
      { text: "Completed: inspect the current Windows implementation and trace the Codex session lifecycle", status: "completed" },
      { text: "Currently restructuring plan events and semantic state without leaking raw tool commands into the overview", status: "in_progress" },
      { text: "Pending: run the complete integration regression suite and validate the actual installed build", status: "pending" },
    ] }) ?? [];
    active[0].hasStructuredPlan = true;
    active[0].completedPlanCount = 1;
    active[0].totalPlanCount = 3;
  } else if (kind === "finished") {
    active[0].planSteps = defaultPlan.map((step, index) => ({ ...step, status: index < 3 ? "completed" as const : "pending" as const }));
    active[0].hasStructuredPlan = true;
    active[0].completedPlanCount = 3;
    active[0].totalPlanCount = 5;
    active[0].currentStatus = "Task finished with two steps remaining";
  }
  active[0].taskTitle = kind === "one" ? "Fix session naming"
    : kind === "longtitle" ? "Improve semantic task titles and progress visibility across multiple Codex sessions"
    : kind === "taskchange" ? "Fix usage synchronization"
    : kind === "newtask" ? "Polish session rail"
    : "Improve progress visibility";
  if (kind === "one") active[0].currentStatus = "Tracing session metadata";
  if (kind === "taskchange") active[0].currentStatus = "Comparing live rate snapshots";
  if (kind === "newtask") {
    active[0].name = "Coucou";
    active[0].currentStatus = "Reviewing rail spacing";
    active[0].taskStartedAt = previewNow - 5_000;
  }
  if (kind === "longplan") active[0].taskTitle = "Improve plan event handling and task progress across sessions";
  if (kind === "overhour") active[0].taskStartedAt = previewNow - 4_053_000;
  if (kind === "collapsedactive") {
    active[0].taskTitle = "Fix usage sync";
    active[0].currentStatus = "Running validation";
    active[0].planSteps = [];
    active[0].hasStructuredPlan = false;
    active[0].taskStartedAt = previewNow - 374_000;
  }
  if (kind === "collapsedplan") {
    active[0].taskTitle = "Fix usage sync";
    active[0].planSteps = defaultPlan.map((step) => ({ ...step }));
    active[0].hasStructuredPlan = true;
    active[0].completedPlanCount = 2;
    active[0].totalPlanCount = 5;
    active[0].taskStartedAt = previewNow - 1_122_000;
  }
  const baseUsage = {
    available: true,
    fetchedAt: kind === "stale" ? previewNow - 240_000 : previewNow,
    planType: "plus",
    limitId: "codex",
    source: "snapshot" as const,
    lastFullReadAt: previewNow,
    lastRollingUpdateAt: null,
    fiveHour: { usedPercent: kind === "low" ? 96 : 28, remainingPercent: kind === "low" ? 4 : kind === "mixed" ? 72 : 72, windowDurationMins: 300, resetsAt: 1790958335, limitId: "codex", source: "snapshot" as const, receivedAt: previewNow, emittedAt: null, requestStartedAt: previewNow - 100 },
    weekly: { usedPercent: kind === "low" ? 98 : kind === "mixed" ? 95 : 39, remainingPercent: kind === "low" ? 2 : kind === "mixed" ? 5 : 61, windowDurationMins: 10080, resetsAt: 1791050065, limitId: "codex", source: "snapshot" as const, receivedAt: previewNow, emittedAt: null, requestStartedAt: previewNow - 100 },
    ...(kind === "stale" ? { error: "stale", lastErrorAt: previewNow } : {}),
  };
  State.codexUsage = kind === "unavailable" ? { available: false, source: "unavailable", fetchedAt: previewNow, lastFullReadAt: null, lastRollingUpdateAt: null, lastErrorAt: previewNow, error: "unavailable" } : baseUsage;

  active.forEach((task, index) => {
    task.id = `${task.id}-${kind}`;
    task.sessionId = `${kind}-${index}`;
  });
  if (kind === "long") active[0].name = longName;
  State.tasks = active;
  State.focusId = active[0].id;
  State.pendingApproval = kind === "approval" || kind === "longpermission" ? {
    requestId: "preview-approval",
    sessionId: active[0].sessionId!,
    turnId: "preview-turn",
    taskId: active[0].id,
    provider: "codex",
    tool: "PowerShell",
    command: kind === "longpermission"
      ? `Remove-Item -LiteralPath 'C:\\Users\\lakhs\\Documents\\Codex\\${"long-workspace-".repeat(24)}build\\old-output.tmp' -WhatIf`
      : "Remove-Item -WhatIf .\\build\\old-output.tmp",
  } : null;
  State.notify();
  const collapsed = kind === "collapsedactive" || kind === "collapsedplan";
  document.body.classList.toggle("preview-collapsed", collapsed);
  const viewName = kind === "approval" || kind === "longpermission" ? "approval" : "overview";
  island.alert(viewName);
  State.mode = collapsed ? "compact" : "expanded";
  State.notify();
  document.getElementById("content")!.style.opacity = "1";
  document.querySelectorAll<HTMLElement>(".view").forEach((view) => {
    view.classList.toggle("on", view.classList.contains(viewName));
  });
  if (kind === "rail") {
    active[1].planSteps = [
      { text: "Inspect current build", status: "completed" },
      { text: "Prepare Windows package", status: "in_progress" },
      { text: "Verify installed version", status: "pending" },
    ];
    active[1].hasStructuredPlan = true;
    active[1].completedPlanCount = 1;
    active[1].totalPlanCount = 3;
    active[1].currentStatus = "Preparing Windows package";
    active[2].currentStatus = "Building application";
    active[3].planSteps = [
      { text: "Review existing tokens", status: "completed" },
      { text: "Document component spacing", status: "pending" },
    ];
    active[3].hasStructuredPlan = true;
    active[3].completedPlanCount = 1;
    active[3].totalPlanCount = 2;
    active[3].currentStatus = "Task finished";
  }
  document.querySelectorAll<HTMLButtonElement>("#preview-controls button").forEach((button) => {
    button.classList.toggle("selected", button.dataset.state === kind);
  });
  if (collapsed) {
    State.mode = "compact";
    State.notify();
  }
  if (updateTimer != null) window.clearTimeout(updateTimer);
  updateTimer = kind === "update" ? window.setTimeout(advancePlanPreview, 1800) : undefined;
}

document.querySelectorAll<HTMLButtonElement>("#preview-controls button").forEach((button) => {
  button.addEventListener("click", () => show(button.dataset.state ?? "one"));
});

window.addEventListener("popstate", () => show(new URLSearchParams(location.search).get("state") ?? "five", false));
const initialState = new URLSearchParams(location.search).get("state") ?? "five";
show(initialState, false);

function advancePlanPreview() {
  window.setTimeout(() => {
    const focused = State.focusTask;
    if (!focused || !focused.hasStructuredPlan) return;
    State.setPlan(focused.id, [
      { ...defaultPlan[0] },
      { ...defaultPlan[1], status: "completed" },
      { ...defaultPlan[2], status: "completed" },
      { ...defaultPlan[3], status: "in_progress" },
      { ...defaultPlan[4] },
    ]);
  }, 1800);
}
