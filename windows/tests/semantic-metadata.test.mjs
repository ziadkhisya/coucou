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

test("plan labels drop redundant status markers and prefixes", () => {
  const parsed = planParser.parseUpdatePlan({ steps: [
    { text: "Completed: Step 1: inspect usage source", status: "completed" },
    { text: "Currently: fix refresh behavior", status: "in_progress" },
    { text: "[ ] Pending: validate live values", status: "pending" },
    { text: "Currently tracing drift", status: "pending" },
  ] });
  assert.deepEqual(parsed.map((step) => step.text), [
    "inspect usage source", "fix refresh behavior", "validate live values", "tracing drift",
  ]);
  assert.equal(planParser.normalizePlanStepText("In progress — validate the installed build"), "validate the installed build");
  const imperative = planParser.parseUpdatePlan({ steps: [
    { text: "Complete the migration", status: "pending" },
    { text: "Current workspace identity", status: "in_progress" },
    { text: "Currently: validate the installed build", status: "pending" },
  ] });
  assert.deepEqual(imperative.map((step) => step.text), [
    "Complete the migration", "Current workspace identity", "validate the installed build",
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
  assert.equal(timers.formatTaskDuration(1_122_000), "18m 42s");
  assert.equal(timers.formatTaskDuration(4_053_000), "1h 07m");
  assert.equal(timers.formatTaskDuration(42_000), "42s");
  assert.equal(timers.formatTaskDuration(165_000), "2m 45s");
  assert.equal(timers.formatTaskDuration(4_933_000), "1h 22m");
  assert.equal(timers.formatTaskDuration(7_620_000), "2h 07m");
  State.setFocus("integration_codex");
  assert.equal(timers.taskElapsedMs(State.tasks.find((task) => task.id === id), finishedAt + 90_000), finishedAt - 10_000);
  State.resetTask(id, 20_000);
  assert.equal(State.tasks.find((task) => task.id === id).taskStartedAt, 20_000);
  assert.equal(timers.formatTaskDuration(5_000), "5s");
  assert.equal(timers.formatTaskDuration(65_000), "1m 5s");
  assert.equal(timers.formatTaskDuration(0), "0s");
  assert.equal(timers.formatTaskDuration(3_667_000), "1h 01m");
  assert.equal(timers.compactTaskTitle("Codex"), "Starting task");
  assert.equal(timers.compactTaskTitle(""), "Starting task");
  assert.equal(timers.compactTaskTitle("Find winning products"), "Find winning products");
  assert.equal(timers.compactTaskTitle("Fix product importer"), "Fix product importer");
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

test("goal timer survives turn completion, plan replacement, and task continuation", () => {
  State.tasks = [];
  const id = State.upsertCodeSession("codex", "goal-timer-session", "DropshiFlow", "C:/work/dropshi");
  State.resetTask(id, 10_000, true);
  State.setTaskTitle(id, "Find winning products");
  State.updateTask(id, "finished", 30_000);
  const task = State.tasks[0];
  assert.equal(timers.taskElapsedMs(task, 70_000), 60_000);
  State.resetTask(id, 80_000);
  assert.equal(task.goalStartedAt, 10_000);
  assert.equal(task.taskTitle, "Find winning products");
  assert.equal(timers.taskElapsedMs(task, 90_000), 80_000);
  State.setPlan(id, [{ text: "Continue goal work", status: "in_progress" }]);
  assert.equal(task.goalStartedAt, 10_000);
  State.endGoal(id, 100_000);
  assert.equal(timers.taskElapsedMs(task, 200_000), 90_000);
});

test("goal timer metadata rehydrates by provider and session id", () => {
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
  });
  State.tasks = [];
  const id = State.upsertCodeSession("codex", "rehydrate-goal", "Coucou", "C:/work/coucou");
  State.resetTask(id, 123_000, true);
  State.setTaskTitle(id, "Fix goal lifecycle");
  State.tasks = [];
  const restoredId = State.upsertCodeSession("codex", "rehydrate-goal", "Coucou", "C:/work/coucou");
  const restored = State.tasks.find((task) => task.id === restoredId);
  assert.equal(restored.goalActive, true);
  assert.equal(restored.goalStartedAt, 123_000);
  assert.equal(restored.taskTitle, "Fix goal lifecycle");
  assert.equal(timers.taskElapsedMs(restored, 183_000), 60_000);
  delete globalThis.localStorage;
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
  assert.equal(stale, current, "ignored snapshots preserve identity so UI diagnostics can recognize the stale response");
  assert.equal(stale.fiveHour.usedPercent, 25);
  assert.equal(stale.lastRollingUpdateAt, 240);
});

test("app-server emitted timestamps normalize before rate snapshot race checks", () => {
  const payload = { rateLimits: {
    primary: { usedPercent: 20, windowDurationMins: 300 },
    secondary: { usedPercent: 30, windowDurationMins: 10_080 },
  } };
  const seconds = 1_800_000_000;
  const parsed = usage.parseCodexUsage(payload, seconds * 1000 + 100, { emittedAt: seconds });
  assert.equal(parsed.fiveHour.emittedAt, seconds * 1000);
  let current = usage.mergeCodexUsage(parsed, { method: "account/rateLimits/updated", params: {
    rateLimits: { primary: { usedPercent: 25 } },
  } }, seconds * 1000 + 300, { source: "notification", emittedAt: seconds + 1 });
  assert.equal(current.fiveHour.emittedAt, (seconds + 1) * 1000);
  const staleSnapshot = usage.mergeCodexUsage(current, payload, seconds * 1000 + 500, {
    source: "snapshot", requestStartedAt: seconds * 1000 - 100,
  });
  assert.strictEqual(staleSnapshot, current);
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
  const accountUsage = State.codexUsage;
  State.setFocus(b);
  assert.equal(State.tasks.find((task) => task.id === a).taskTitle, "Fix progress");
  assert.equal(State.tasks.find((task) => task.id === b).taskStartedAt, 9_000);
  assert.strictEqual(State.codexUsage, accountUsage, "account usage stays shared when session focus changes");
  State.setFocus(a);
  assert.strictEqual(State.codexUsage, accountUsage);
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
  assert.equal(content.timer, "18m 42s");
  assert.match(content.status, /^2\/5 · Comparing/);
  assert.equal(content.taskTitle, "Check live rate limits");
  assert.doesNotMatch(content.status, /PowerShell|command/i);
  assert.match(content.title, /Research workspace/);
  assert.match(content.title, /Check live rate limits/);
});

test("same-project rail sessions expose independent task titles", () => {
  const base = {
    name: "DropshiFlow", color: "#35A67A", state: "working",
    stepIndex: 0, stepRevision: 0, activityOrder: 0, steps: [], planSteps: [], hasStructuredPlan: false,
    completedPlanCount: 0, totalPlanCount: 0, currentStatus: "Working", lastSemanticMessage: "",
    taskStartedAt: 0, taskFinishedAt: null, source: "codex", isIntegration: false,
    provider: "codex", sessionId: "same-project",
  };
  const first = rail.sessionRailContent({ ...base, id: "one", taskTitle: "Find winning products" }, 5_000);
  const second = rail.sessionRailContent({ ...base, id: "two", taskTitle: "Fix product importer" }, 5_000);
  assert.equal(first.taskTitle, "Find winning products");
  assert.equal(second.taskTitle, "Fix product importer");
  assert.notEqual(first.taskTitle, second.taskTitle);
});

test("session rail titles use the deterministic preview clock", () => {
  globalThis.__COUCOU_PREVIEW_NOW = 1_122_000;
  const task = {
    id: "rail-clock", name: "Coucou", color: "#35A67A", state: "working",
    stepIndex: 0, stepRevision: 0, activityOrder: 0, steps: [], planSteps: [], hasStructuredPlan: false,
    completedPlanCount: 0, totalPlanCount: 0, taskTitle: "Fix timer summary", currentStatus: "Updating progress",
    lastSemanticMessage: "", taskStartedAt: 0, taskFinishedAt: null, source: "codex", isIntegration: false,
    provider: "codex", sessionId: "rail-clock-session",
  };
  const content = rail.sessionRailContent(task);
  assert.equal(content.timer, "18m 42s");
  assert.equal(content.title, "Coucou · Fix timer summary · Updating progress · 18m 42s");
  delete globalThis.__COUCOU_PREVIEW_NOW;
});
