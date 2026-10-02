import "../src/style.css";
import { Island } from "../src/island/island";
import { State, type AgentTask } from "../src/core/state";

const island = new Island(document.getElementById("root")!);
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
    semanticStatus: "Reviewing project files",
    lastSemanticMessage: "Reviewing project files",
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

function show(kind: string) {
  const active = kind === "two" ? [session(0), session(1)]
    : kind === "many" ? [session(0), session(1), session(2), session(3)]
    : kind === "long" ? [session(0, longName)]
    : kind === "finished" ? [session(0, "DropshiFlow", "finished")]
    : kind === "approval" ? [session(0, "DropshiFlow", "approval")]
    : [session(0)];

  if (kind === "five" || kind === "update") {
    active[0].planSteps = defaultPlan.map((step) => ({ ...step }));
    active[0].hasStructuredPlan = true;
    active[0].completedPlanCount = 2;
    active[0].totalPlanCount = 5;
    active[0].semanticStatus = "Replace the activity ticker with semantic progress";
  } else if (kind === "longplan") {
    active[0].planSteps = [
      { text: "Completed: inspect the current Windows implementation and trace the Codex session lifecycle", status: "completed" },
      { text: "Currently restructuring plan events and semantic state without leaking raw tool commands into the overview", status: "in_progress" },
      { text: "Pending: run the complete integration regression suite and validate the actual installed build", status: "pending" },
    ];
    active[0].hasStructuredPlan = true;
    active[0].completedPlanCount = 1;
    active[0].totalPlanCount = 3;
  } else if (kind === "finished") {
    active[0].planSteps = defaultPlan.map((step, index) => ({ ...step, status: index < 3 ? "completed" as const : "pending" as const }));
    active[0].hasStructuredPlan = true;
    active[0].completedPlanCount = 3;
    active[0].totalPlanCount = 5;
    active[0].semanticStatus = "Task finished";
  }

  active.forEach((task, index) => {
    task.id = `${task.id}-${kind}`;
    task.sessionId = `${kind}-${index}`;
  });
  if (kind === "long") active[0].name = longName;
  State.tasks = active;
  State.focusId = active[0].id;
  State.pendingApproval = kind === "approval" ? {
    requestId: "preview-approval",
    sessionId: active[0].sessionId!,
    turnId: "preview-turn",
    taskId: active[0].id,
    provider: "codex",
    tool: "PowerShell",
    command: "Remove-Item -WhatIf .\\build\\old-output.tmp",
  } : null;
  State.notify();
  const viewName = kind === "approval" ? "approval" : "overview";
  island.alert(viewName);
  document.getElementById("content")!.style.opacity = "1";
  document.querySelectorAll<HTMLElement>(".view").forEach((view) => {
    view.classList.toggle("on", view.classList.contains(viewName));
  });
  document.querySelectorAll<HTMLButtonElement>("#preview-controls button").forEach((button) => {
    button.classList.toggle("selected", button.dataset.state === kind);
  });
}

document.querySelectorAll<HTMLButtonElement>("#preview-controls button").forEach((button) => {
  button.addEventListener("click", () => show(button.dataset.state ?? "one"));
});

const initialState = new URLSearchParams(location.search).get("state") ?? "five";
show(initialState);

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
if (initialState === "update") advancePlanPreview();

let updateTimer: number | undefined;
document.querySelector<HTMLButtonElement>('[data-state="update"]')?.addEventListener("click", () => {
  window.clearTimeout(updateTimer);
  show("update");
  updateTimer = window.setTimeout(advancePlanPreview, 0);
});

