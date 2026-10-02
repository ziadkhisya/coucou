import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function load(entryPoint) {
  const { outputFiles } = await build({ entryPoints: [entryPoint], bundle: true, write: false, format: "esm", platform: "node", target: "node20" });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
}

const [{ State }, { deriveProjectName }, timers, progress, usage] = await Promise.all([
  load("src/core/state.ts"), load("src/core/project.ts"), load("src/core/timer.ts"),
  load("src/core/progress.ts"), load("src/core/usage.ts"),
]);

test("repository identity wins over transient goal folder slugs", () => {
  assert.equal(deriveProjectName({ cwd: "C:/work/goal-i-already-downloaded-the-coucou" }), "Codex");
  assert.equal(deriveProjectName({ gitRemote: "https://github.com/ziadkhisya/coucou.git", cwd: "C:/work/goal-coucou" }), "Coucou");
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

test("Codex rate limits normalize both windows and preserve raw percentages", () => {
  const snapshot = usage.parseCodexUsage({ rateLimits: {
    limitId: "codex", planType: "plus",
    primary: { usedPercent: 16, windowDurationMins: 300, resetsAt: 1790958335 },
    secondary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1791050065 },
  } }, 1234);
  assert.equal(snapshot.primary.remainingPercent, 84);
  assert.equal(snapshot.secondary.remainingPercent, 1);
  assert.equal(snapshot.primary.resetsAt, 1790958335);
  assert.equal(snapshot.fetchedAt, 1234);
  assert.equal(usage.displayPercent(120), 100);
  assert.equal(usage.displayPercent(-5), 0);
  assert.match(usage.formatResetTime(snapshot.primary.resetsAt), /resets/);
  assert.equal(usage.parseCodexUsage({ accountId: "redacted", rateLimits: {} }), null);
});

test("sparse account usage updates merge with cached windows and missing data is safe", () => {
  const original = usage.parseCodexUsage({ rateLimits: {
    limitId: "codex", planType: "plus",
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 111 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 222 },
  } }, 1);
  const merged = usage.mergeCodexUsage(original, { method: "account/rateLimits/updated", params: {
    rateLimits: { primary: { usedPercent: 35 } },
  } }, 2);
  assert.equal(merged.primary.remainingPercent, 65);
  assert.equal(merged.primary.resetsAt, 111);
  assert.equal(merged.secondary.remainingPercent, 60);
  assert.equal(merged.fetchedAt, 2);
  assert.equal(usage.mergeCodexUsage(original, { params: {} }), original);
});

test("multiple sessions retain separate task clocks and titles", () => {
  State.tasks = [];
  const a = State.upsertCodeSession("codex", "a", "Coucou", "C:/work/coucou");
  const b = State.upsertCodeSession("codex", "b", "Personal Site", "C:/work/site");
  State.resetTask(a, 1_000); State.setTaskTitle(a, "Fix progress");
  State.resetTask(b, 9_000); State.setTaskTitle(b, "Polish landing page");
  State.codexUsage = { available: true, fetchedAt: 1, primary: { usedPercent: 0, remainingPercent: 100, windowDurationMins: 300, resetsAt: null } };
  State.setFocus(b);
  assert.equal(State.tasks.find((task) => task.id === a).taskTitle, "Fix progress");
  assert.equal(State.tasks.find((task) => task.id === b).taskStartedAt, 9_000);
  assert.equal(State.codexUsage.primary.remainingPercent, 100);
});
