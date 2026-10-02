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
    source: "codex",
    isIntegration: false,
    provider: "codex",
    sessionId: `preview-${index}`,
    pillBadge: state === "finished" ? "finished" : state === "approval" ? "approval" : null,
    sessionCwd: `C:\\Users\\lakhs\\Projects\\${name}`,
  };
}

const longName = "Coucou Personal Workflow and Windows Codex Integration Monorepo";

function show(kind: string) {
  const active = kind === "two" ? [session(0), session(1)]
    : kind === "many" ? [session(0), session(1), session(2), session(3)]
    : kind === "long" ? [session(0, longName)]
    : kind === "finished" ? [session(0, "DropshiFlow", "finished")]
    : kind === "approval" ? [session(0, "DropshiFlow", "approval")]
    : [session(0)];

  active.forEach((task, index) => {
    task.id = `${task.id}-${kind}`;
    task.sessionId = `${kind}-${index}`;
  });
  if (kind === "tool") active[0].steps[active[0].stepIndex] = "Executing: Get-Content src\\core\\state.ts";
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
  island.alert(kind === "approval" ? "approval" : "overview");
  document.querySelectorAll<HTMLButtonElement>("#preview-controls button").forEach((button) => {
    button.classList.toggle("selected", button.dataset.state === kind);
  });
}

document.querySelectorAll<HTMLButtonElement>("#preview-controls button").forEach((button) => {
  button.addEventListener("click", () => show(button.dataset.state ?? "one"));
});

show("one");

