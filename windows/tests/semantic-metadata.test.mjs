import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function load(entryPoint) {
  const { outputFiles } = await build({ entryPoints: [entryPoint], bundle: true, write: false, format: "esm", platform: "node", target: "node20" });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
}

const [{ State }, { deriveProjectName }, timers, progress, usage, planParser, rail] = await Promise.all([
  load("src/core/state.ts"), load("src/core/project.ts"), load("src/core/timer.ts"),
  load("src/core/progress.ts"), load("src/core/usage.ts"), load("src/core/plan.ts"), load("src/core/session-rail.ts"),
]);

test("repository identity wins over transient goal folder slugs", () => {
  assert.equal(deriveProjectName({ cwd: "C:/work/goal-i-already-downloaded-the-coucou" }), "Codex");
  assert.equal(deriveProjectName({ gitRemote: "https://github.com/ziadkhisya/coucou.git", cwd: "C:/work/goal-coucou" }), "Coucou");
  assert.equal(deriveProjectName({ projectName: "Coucou Workspace", gitRemote: "https://github.com/example/other.git", gitRootName: "other" }), "Coucou Workspace");
  assert.equal(deriveProjectName({ projectName: "Personal Site", cwd: "C:/work/goal-task" }), "Personal Site");
});

test("task title and semantic status work independently of project and plan", () => {
  State.tasks = [];
  const id = State.upsertCodeSession("codex", "semantic-session", "Coucou", "C:/work/coucou");
  State.resetTask(id, 1_000);
  State.setTaskTitle(id, "Trace session naming");
  State.setSemanticStatus(id, "Reviewing repository metadata");
  const task = State.tasks.find((item) => item.id === id);
  assert.equal(task.name, "Coucou");
  assert.equal(task.taskTitle, "Trace session naming");
  assert.equal(task.currentStatus, "Reviewing repository metadata");
  assert.equal(task.hasStructuredPlan, false);
});

test("metadata-only progress parses without requiring a checklist", () => {
  assert.deepEqual(progress.parseProgressUpdate({ task_title: "Fix task labels", current_status: "Tracing session naming" }), {
    taskTitle: "Fix task labels", currentStatus: "Tracing session naming",
  });
  assert.deepEqual(progress.parseProgressUpdate({ task_title: "Build app", steps: [{ text: "Inspect files", status: "completed" }] }), {
    taskTitle: "Build app", steps: [{ text: "Inspect files", status: "completed" }],
  });
  assert.deepEqual(progress.parseProgressUpdate({ plan: [{ step: "Inspect files", status: "inProgress" }] }), {
    steps: [{ text: "Inspect files", status: "in_progress" }],
  });
});

test("plan labels drop redundant status markers but retain natural wording", () => {
  const parsed = planParser.parseUpdatePlan({ steps: [
    { text: "Completed: Step 1: inspect usage source", status: "completed" },
    { text: "Currently: fix refresh behavior", status: "in_progress" },
    { text: "[ ] Pending: validate live values", status: "pending" },
    { text: "Currently tracing drift", status: "pending" },
  ] });
  assert.deepEqual(parsed.map((step) => step.text), [
    "inspect usage source", "fix refresh behavior", "validate live values", "Currently tracing drift",
  ]);
});

test("task clock resets on new task, freezes at finish, and formats both ranges", () => {
  State.tasks = [];
  const id = State.upsertCodeSession("codex", "timer-session", "Coucou", "C:/work/coucou");
  State.resetTask(id, 10_000);
  assert.equal(timers.taskElapsedMs(State.tasks[0], 1_132_000), 1_122_000);
  State.updateTask(id, "finished");
  const finishedAt = State.tasks[0].taskFinishedAt;
  assert.equal(timers.taskElapsedMs(State.tasks[0], finishedAt + 50_000), finishedAt - 10_000);
  assert.equal(timers.formatTaskDuration(1_122_000), "18:42");
  assert.equal(timers.formatTaskDuration(4_053_000), "1:07:33");
  State.setFocus("integration_codex");
  assert.equal(timers.taskElapsedMs(State.tasks.find((task) => task.id === id), finishedAt + 90_000), finishedAt - 10_000);
  State.resetTask(id, 20_000);
  assert.equal(State.tasks.find((task) => task.id === id).taskStartedAt, 20_000);
  assert.equal(timers.formatTaskDuration(5_000), "00:05");
  assert.equal(timers.formatTaskDuration(65_000), "01:05");
  const planBefore = State.tasks.find((task) => task.id === id).taskStartedAt;
  State.setPlan(id, [{ text: "Run validation", status: "in_progress" }]);
  assert.equal(State.tasks.find((task) => task.id === id).taskStartedAt, planBefore);
});

test("authoritative stop timestamps freeze the task clock", () => {
  State.tasks = [];
  const id = State.upsertCodeSession("codex", "timestamp-clock", "Coucou", "C:/work/coucou");
  State.resetTask(id, 10_000);
  State.updateTask(id, "finished", 15_000);
  assert.equal(State.tasks[0].taskFinishedAt, 15_000);
  assert.equal(timers.taskElapsedMs(State.tasks[0], 90_000), 5_000);
});

test("error and stop states freeze task duration too", () => {
  State.tasks = [];
  const id = State.upsertCodeSession("codex", "terminal-clock", "Coucou", "C:/work/coucou");
  State.resetTask(id, 5_000);
  State.updateTask(id, "error");
  const errorAt = State.tasks[0].taskFinishedAt;
  assert.equal(timers.taskElapsedMs(State.tasks[0], errorAt + 40_000), errorAt - 5_000);
  State.resetTask(id, 50_000);
  State.updateTask(id, "interrupted");
  const stoppedAt = State.tasks[0].taskFinishedAt;
  assert.equal(timers.taskElapsedMs(State.tasks[0], stoppedAt + 40_000), stoppedAt - 50_000);
});

test("Codex windows use duration regardless of primary/secondary order", () => {
  const snapshot = usage.parseCodexUsage({ rateLimitsByLimitId: { codex: {
    limitId: "codex", planType: "plus",
    primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1791050065 },
    secondary: { usedPercent: 16, windowDurationMins: 300, resetsAt: 1790958335 },
  } } }, 1234);
  assert.equal(snapshot.fiveHour.remainingPercent, 84);
  assert.equal(snapshot.weekly.remainingPercent, 1);
  assert.equal(snapshot.fiveHour.resetsAt, 1790958335);
  assert.equal(snapshot.fetchedAt, 1234);
  assert.equal(usage.displayPercent(120), 100);
  assert.equal(usage.displayPercent(-5), 0);
  assert.equal(usage.displayPercent(77.6), 78);
  assert.equal(usage.usageSeverity(72), "healthy");
  assert.equal(usage.usageSeverity(40), "warning");
  assert.equal(usage.usageSeverity(14), "critical");
  assert.match(usage.formatResetTime(snapshot.fiveHour.resetsAt), /resets/);
  assert.equal(usage.parseCodexUsage({ accountId: "redacted", rateLimits: {} }), null);
});

test("sparse rolling usage updates merge by duration and preserve freshness metadata", () => {
  const original = usage.parseCodexUsage({ rateLimits: {
    limitId: "codex", planType: "plus",
    primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 222 },
    secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 111 },
  } }, 1);
  const merged = usage.mergeCodexUsage(original, { method: "account/rateLimits/updated", params: {
    rateLimits: { secondary: { usedPercent: 35 } },
  } }, 2, { source: "notification" });
  assert.equal(merged.fiveHour.remainingPercent, 65);
  assert.equal(merged.fiveHour.resetsAt, 111);
  assert.equal(merged.weekly.remainingPercent, 60);
  assert.equal(merged.fetchedAt, 2);
  assert.equal(merged.lastFullReadAt, 1);
  assert.equal(merged.lastRollingUpdateAt, 2);
  assert.equal(merged.fiveHour.source, "notification");
  assert.equal(usage.mergeCodexUsage(original, { params: {} }), original);
});

test("an older full read cannot overwrite a newer rolling update", () => {
  let current = usage.parseCodexUsage({ rateLimits: {
    primary: { usedPercent: 22, windowDurationMins: 300 },
    secondary: { usedPercent: 99, windowDurationMins: 10080 },
  } }, 200, { requestStartedAt: 190 });
  current = usage.mergeCodexUsage(current, { method: "account/rateLimits/updated", params: {
    rateLimits: { primary: { usedPercent: 25 } },
  } }, 240, { source: "notification" });
  const stale = usage.mergeCodexUsage(current, { rateLimits: {
    primary: { usedPercent: 22, windowDurationMins: 300 },
    secondary: { usedPercent: 99, windowDurationMins: 10080 },
  } }, 260, { source: "snapshot", requestStartedAt: 180 });
  assert.equal(stale.fiveHour.usedPercent, 25);
  assert.equal(stale.lastRollingUpdateAt, 240);
});

test("usage freshness distinguishes fresh, stale, and unavailable data", () => {
  const fresh = usage.parseCodexUsage({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } }, 1_000);
  assert.equal(usage.usageFreshness(fresh, 61_000), "fresh");
  assert.equal(usage.usageFreshness(fresh, 200_000), "stale");
  assert.equal(usage.usageFreshness(usage.markUsageUnavailable(null, 3_000)), "unavailable");
  const stale = usage.markUsageUnavailable(fresh, 2_000);
  assert.equal(stale.fiveHour.usedPercent, 20);
  assert.equal(usage.usageFreshness(stale, 3_000), "stale");
});

test("multiple sessions retain separate task clocks and titles", () => {
  State.tasks = [];
  const a = State.upsertCodeSession("codex", "a", "Coucou", "C:/work/coucou");
  const b = State.upsertCodeSession("codex", "b", "Personal Site", "C:/work/site");
  State.resetTask(a, 1_000); State.setTaskTitle(a, "Fix progress");
  State.resetTask(b, 9_000); State.setTaskTitle(b, "Polish landing page");
  State.codexUsage = { available: true, fetchedAt: 1, fiveHour: { usedPercent: 0, remainingPercent: 100, windowDurationMins: 300, resetsAt: null, limitId: "codex", source: "snapshot", receivedAt: 1, emittedAt: null, requestStartedAt: null } };
  State.setFocus(b);
  assert.equal(State.tasks.find((task) => task.id === a).taskTitle, "Fix progress");
  assert.equal(State.tasks.find((task) => task.id === b).taskStartedAt, 9_000);
  assert.equal(State.codexUsage.fiveHour.remainingPercent, 100);
});

test("session rail keeps the timer separate from semantic progress and truncatable status", () => {
  const task = {
    id: "rail", name: "Research workspace", color: "#35A67A", state: "working",
    stepIndex: 0, stepRevision: 0, activityOrder: 0, steps: [], planSteps: [], hasStructuredPlan: true,
    completedPlanCount: 2, totalPlanCount: 5, taskTitle: "Check live rate limits", currentStatus: "Comparing current Codex account windows",
    lastSemanticMessage: "", taskStartedAt: 0, taskFinishedAt: null, source: "codex", isIntegration: false,
    provider: "codex", sessionId: "rail-session",
  };
  const content = rail.sessionRailContent(task, 1_122_000);
  assert.equal(content.timer, "18:42");
  assert.match(content.status, /^2\/5 · Comparing/);
  assert.doesNotMatch(content.status, /18:42|PowerShell|command/i);
  assert.match(content.title, /Research workspace/);
});
