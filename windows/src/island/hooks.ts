// Claude Code and Codex hook events → independent island session tasks.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type CodeProvider } from "../core/state";
import { parseProgressUpdate } from "../core/progress";
import { deriveProjectName } from "../core/project";
import type { Island } from "./island";

const FALLBACK_TASK: Record<CodeProvider, string> = {
  claude: "integration_claude",
  codex: "integration_codex",
};

interface HookPayload {
  provider?: CodeProvider;
  hook_event_name?: string;
  request_id?: string;
  resolution?: string;
  session_id?: string;
  turn_id?: string;
  event_seq?: number;
  cwd?: string;
  project_name?: string;
  git_root_name?: string;
  git_remote?: string;
  message?: string;
  prompt?: string;
  last_assistant_message?: string;
  error?: string;
  tool_status?: string;
  tool_error?: string;
  tool_exit_code?: number;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: Record<string, unknown>;
  timestamp?: string | number;
}

interface SessionRuntime {
  turnId: string | null;
  retiredTurnIds: string[];
  lastSequence: number | null;
  runToken: number;
  finishTimer: number | null;
  started: boolean;
  ended: boolean;
  terminal: boolean;
}

const sessions = new Map<string, SessionRuntime>();
const endedSessionOrder: string[] = [];
const MAX_ENDED_SESSION_TOMBSTONES = 256;
const MAX_RETIRED_TURNS = 32;
const approvalTimers = new Map<string, number>();
let nextRunToken = 1;

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function sessionKey(provider: CodeProvider, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

function taskIdFor(provider: CodeProvider, sessionId: string, projectName: string, cwd: string): string {
  return sessionId
    ? State.upsertCodeSession(provider, sessionId, projectName, cwd)
    : FALLBACK_TASK[provider];
}

function runtimeFor(provider: CodeProvider, sessionId: string): SessionRuntime | null {
  if (!sessionId) return null;
  const key = sessionKey(provider, sessionId);
  let runtime = sessions.get(key);
  if (!runtime) {
    runtime = {
      turnId: null,
      retiredTurnIds: [],
      lastSequence: null,
      runToken: nextRunToken++,
      finishTimer: null,
      started: false,
      ended: false,
      terminal: false,
    };
    sessions.set(key, runtime);
  }
  return runtime;
}

function forgetEndedSession(key: string) {
  const index = endedSessionOrder.indexOf(key);
  if (index >= 0) endedSessionOrder.splice(index, 1);
}

function rememberEndedSession(key: string, runtime: SessionRuntime) {
  runtime.ended = true;
  forgetEndedSession(key);
  endedSessionOrder.push(key);
  while (endedSessionOrder.length > MAX_ENDED_SESSION_TOMBSTONES) {
    const expiredKey = endedSessionOrder.shift()!;
    const expired = sessions.get(expiredKey);
    if (expired?.ended) sessions.delete(expiredKey);
  }
}

function retireTurn(runtime: SessionRuntime, turnId: string | null) {
  if (!turnId || runtime.retiredTurnIds.includes(turnId)) return;
  runtime.retiredTurnIds.push(turnId);
  if (runtime.retiredTurnIds.length > MAX_RETIRED_TURNS) runtime.retiredTurnIds.shift();
}

function acceptOrdering(
  runtime: SessionRuntime | null,
  payload: HookPayload,
  eventName: string,
): boolean {
  if (!runtime) return true;
  const sequence = payload.event_seq;
  if (typeof sequence === "number" && runtime.lastSequence != null && sequence <= runtime.lastSequence) return false;

  // SessionEnd tombstones stop delayed events from recreating removed cards.
  // A later explicit SessionStart can reuse the same provider/session ID.
  if (runtime.ended && eventName !== "SessionStart") return false;

  if (eventName === "SessionStart") {
    if (runtime.started && !runtime.ended) return false;
    if (runtime.ended && payload.turn_id && runtime.retiredTurnIds.includes(payload.turn_id)) return false;
    if (runtime.turnId && runtime.turnId !== payload.turn_id) retireTurn(runtime, runtime.turnId);
    runtime.turnId = payload.turn_id ?? null;
    runtime.runToken = nextRunToken++;
    runtime.started = true;
    runtime.ended = false;
    runtime.terminal = false;
    forgetEndedSession(sessionKey(payload.provider === "codex" ? "codex" : "claude", payload.session_id ?? ""));
    if (runtime.finishTimer != null) window.clearTimeout(runtime.finishTimer);
    runtime.finishTimer = null;
    if (typeof sequence === "number") runtime.lastSequence = sequence;
    return true;
  }
  if (eventName === "UserPromptSubmit") {
    // Turn IDs retire old prompts so a delayed submit cannot rewind the session.
    if (payload.turn_id && runtime.retiredTurnIds.includes(payload.turn_id)) return false;
    if (payload.turn_id && runtime.turnId === payload.turn_id) return false;
    retireTurn(runtime, runtime.turnId);
    if (runtime.finishTimer != null) window.clearTimeout(runtime.finishTimer);
    runtime.finishTimer = null;
    runtime.runToken = nextRunToken++;
    if (payload.turn_id) runtime.turnId = payload.turn_id;
    runtime.started = true;
    runtime.terminal = false;
    if (typeof sequence === "number") runtime.lastSequence = sequence;
    return true;
  }
  if (eventName === "SessionEnd") {
    // Session end is scoped by provider/session identity; a stale turn ID must
    // not keep a genuinely closed session card alive.
    retireTurn(runtime, runtime.turnId);
    if (typeof sequence === "number") runtime.lastSequence = sequence;
    if (runtime.finishTimer != null) window.clearTimeout(runtime.finishTimer);
    runtime.finishTimer = null;
    runtime.terminal = true;
    runtime.started = true;
    rememberEndedSession(sessionKey(payload.provider === "codex" ? "codex" : "claude", payload.session_id ?? ""), runtime);
    return true;
  }
  if (runtime.terminal) return false;
  // Turn IDs are the strongest available ordering signal. Codex's terminal
  // lifecycle events should carry one; if one is missing after a known turn,
  // do not let that ambiguous event finish or interrupt the active turn.
  if (payload.turn_id && runtime.retiredTurnIds.includes(payload.turn_id)) return false;
  if (payload.turn_id && runtime.turnId && payload.turn_id !== runtime.turnId) return false;
  if (!payload.turn_id && runtime.turnId && sequence == null &&
      ["Stop", "Interrupt", "Interrupted", "StopFailure"].includes(eventName)) return false;
  if (payload.turn_id && !runtime.turnId) runtime.turnId = payload.turn_id;
  if (typeof sequence === "number") runtime.lastSequence = sequence;
  if (["Stop", "Interrupt", "Interrupted", "StopFailure"].includes(eventName)) runtime.terminal = true;
  runtime.started = true;
  return true;
}

/** Codex apply_patch requests carry the exact diff in their tool input. Keep it
 * whole in the approval model; the UI makes long diffs scrollable. */
function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const key of ["patch", "diff", "unified_diff"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return `${tool} · full patch:\n${value}`;
  }
  for (const key of ["command", "file_path", "path", "url", "query", "pattern", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return `${tool} · ${value.trim()}`;
  }
  const detail = Object.keys(input).length ? JSON.stringify(input, null, 2) : "";
  return detail ? `${tool} · details:\n${detail}` : tool;
}

const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
  exec_command: "Exécute",
  apply_patch: "Modifie",
  read_file: "Lit",
  list_dir: "Liste",
  search_files: "Cherche",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path") ?? str("file_path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const patch = str("patch") ?? str("diff");
  if (patch) {
    const changed = patch.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? "patch";
    return `${label} · ${lastPathComponent(changed)}`;
  }
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

function eventTime(value: unknown): number {
  const parsed = typeof value === "number" ? (value > 10_000_000_000 ? value : value * 1000)
    : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function startsUserGoal(prompt: unknown): boolean {
  return typeof prompt === "string" && /^\s*\/goal(?:\s|$)/i.test(prompt);
}

function semanticToolStatus(tool: string, input: Record<string, unknown>): string {
  const name = tool.toLowerCase();
  const command = typeof input.command === "string" ? input.command.toLowerCase() : "";
  if (/\b(test|vitest|jest|playwright|cargo test|npm test|pnpm test)\b/.test(command)) return "Running tests";
  if (/\b(build|compile|cargo build|npm run build|pnpm build)\b/.test(command)) return "Building application";
  if (/\b(git status|git diff|git log|git commit|git push|git checkout|git switch)\b/.test(command)) return "Updating repository";
  if (/search|web|fetch|browser/.test(name)) return "Researching";
  if (/read|list|glob|grep|find|cat/.test(name)) return "Reviewing project files";
  if (/test|jest|vitest|playwright/.test(name)) return "Running tests";
  if (/build|compile|cargo|npm|pnpm|yarn/.test(name)) return "Building application";
  if (/git|commit|push|branch/.test(name)) return "Updating repository";
  if (/patch|edit|write|replace|multi.?edit/.test(name)) return "Editing files";
  if (/exec|command|shell|powershell|terminal|bash|cmd/.test(name)) return "Running a project command";
  return "Reviewing project context";
}

function conciseCompletion(message: string | undefined): string {
  if (!message?.trim()) return "Task finished";
  const sentence = message.trim().split(/(?<=[.!?])\s|\r?\n/)[0]?.trim();
  return sentence ? sentence.slice(0, 110) : "Task finished";
}

function clearApprovalTimeout(requestId: string) {
  const timer = approvalTimers.get(requestId);
  if (timer != null) window.clearTimeout(timer);
  approvalTimers.delete(requestId);
}

function clearPendingApproval(island: Island, expected = State.pendingApproval): boolean {
  if (!expected || State.pendingApproval !== expected) return false;
  const pending = expected;
  clearApprovalTimeout(pending.requestId);
  State.pendingApproval = null;
  State.isPinned = false;
  island.dropPin();
  if (State.tasks.find((task) => task.id === pending.taskId)?.state === "approval") {
    State.updateTask(pending.taskId, "working");
  }
  State.setPillBadge(pending.taskId, null);
  if (State.view === "approval") island.setView(State.defaultView());
  return true;
}

function approvalMatchesEvent(
  pending: NonNullable<typeof State.pendingApproval>,
  provider: CodeProvider,
  sessionId: string,
  turnId: string | undefined,
): boolean {
  return pending.provider === provider && pending.sessionId === sessionId &&
    pending.turnId === (turnId ?? null);
}

function providerName(provider: CodeProvider): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

function cancelApprovalForEvent(
  island: Island,
  provider: CodeProvider,
  sessionId: string,
  turnId: string | undefined,
  sessionEnd = false,
) {
  const pending = State.pendingApproval;
  if (!pending || pending.provider !== provider || pending.sessionId !== sessionId) return;
  if (!sessionEnd && pending.turnId !== (turnId ?? null)) return;
  if (pending.requestId) void Bridge.approvalDecline(pending.requestId);
  clearPendingApproval(island, pending);
}

function cancelApprovalForSession(island: Island, provider: CodeProvider, sessionId: string) {
  const pending = State.pendingApproval;
  if (!pending || pending.provider !== provider || pending.sessionId !== sessionId) return;
  if (pending.requestId) void Bridge.approvalDecline(pending.requestId);
  clearPendingApproval(island, pending);
}

function handlePermissionRequestClosed(
  island: Island,
  payload: HookPayload,
  provider: CodeProvider,
  sessionId: string,
) {
  const requestId = payload.request_id ?? "";
  const pending = State.pendingApproval;
  if (pending?.requestId === requestId &&
      !approvalMatchesEvent(pending, provider, sessionId, payload.turn_id)) return;
  if (requestId) clearApprovalTimeout(requestId);
  if (!requestId || !pending || pending.requestId !== requestId) return;

  if (payload.resolution === "disconnected" || payload.resolution === "declined" || payload.resolution === "fallback") {
    State.appendStep(pending.taskId, `Approval returned to ${providerName(provider)}`);
  } else if (payload.resolution === "ack_timeout" || payload.resolution === "decision_timeout") {
    State.appendStep(pending.taskId, `Approval timed out; returned to ${providerName(provider)}`);
  }
  clearPendingApproval(island, pending);
  State.notify();
}

/** Pause returns an active permission request to its terminal immediately. */
export function declinePendingApproval(island: Island) {
  const pending = State.pendingApproval;
  if (!pending) return;
  if (pending.requestId) void Bridge.approvalDecline(pending.requestId);
  clearPendingApproval(island);
  State.notify();
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function isUpdatePlanToolName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "update_plan" || normalized.endsWith("__update_plan");
}

function handleHook(island: Island, payload: HookPayload) {
  const provider: CodeProvider = payload.provider === "codex" ? "codex" : "claude";
  const name = payload.hook_event_name ?? "";
  const sessionId = payload.session_id ?? "";
  if (name === "PermissionRequestClosed") {
    handlePermissionRequestClosed(island, payload, provider, sessionId);
    return;
  }
  if (State.paused && name !== "SessionEnd") {
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    if (State.pendingApproval?.requestId === payload.request_id) clearPendingApproval(island);
    return;
  }

  const cwd = payload.cwd ?? "";
  const projectName = deriveProjectName({ projectName: payload.project_name, gitRootName: payload.git_root_name,
    gitRemote: payload.git_remote, cwd });
  const runtime = runtimeFor(provider, sessionId);
  if (!acceptOrdering(runtime, payload, name)) {
    if (name === "PermissionRequest" && payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }
  const hadSessionTask = sessionId && State.tasks.some((candidate) =>
    candidate.provider === provider && candidate.sessionId === sessionId);
  const taskId = taskIdFor(provider, sessionId, projectName, cwd);
  if (sessionId && !hadSessionTask) State.focusCodeSessionIfIdle(taskId);
  const task = State.tasks.find((candidate) => candidate.id === taskId);
  const focused = State.focusId === taskId;

  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  switch (name) {
    case "SessionStart":
      if (task) {
        task.steps = [];
        task.stepIndex = 0;
        task.stepRevision++;
        task.planSteps = [];
        task.hasStructuredPlan = false;
        task.completedPlanCount = 0;
        task.totalPlanCount = 0;
        task.currentStatus = "Connected";
        task.lastSemanticMessage = "";
        State.updateTask(taskId, "idle");
        task.pillBadge = null;
      }
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      // A new turn supersedes any unanswered request from the same session.
      cancelApprovalForSession(island, provider, sessionId);
      const asked = payload.prompt ?? payload.message;
      if (provider === "codex") {
        State.resetTask(taskId, eventTime(payload.timestamp), startsUserGoal(asked));
      }
      State.updateTask(taskId, "thinking");
      State.setPillBadge(taskId, null);
      if (provider === "codex") {
        State.setSemanticStatus(taskId, "Reviewing project files");
      } else if (asked) State.appendStep(taskId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      State.updateTask(taskId, "working");
      const tool = payload.tool_name ?? "Tool";
      if (provider === "codex") {
        if (isUpdatePlanToolName(tool)) {
          const update = parseProgressUpdate(payload.tool_input);
          if (update?.taskTitle) State.setTaskTitle(taskId, update.taskTitle);
          if (update?.steps) State.setPlan(taskId, update.steps);
          if (update?.currentStatus) State.setSemanticStatus(taskId, update.currentStatus);
        } else if (!task?.hasStructuredPlan) {
          State.setSemanticStatus(taskId, semanticToolStatus(tool, payload.tool_input ?? {}));
        }
      } else {
        State.appendStep(taskId, stepLabel(tool, payload.tool_input ?? {}));
      }
      surface("overview", false);
      break;
    }

    case "PostToolUse": {
      const failed = ["failed", "tool_result_failed", "error"].includes((payload.tool_status ?? "").toLowerCase()) ||
        Boolean(payload.tool_error) || (typeof payload.tool_exit_code === "number" && payload.tool_exit_code !== 0);
      if (failed) {
        State.updateTask(taskId, "error", eventTime(payload.timestamp));
        if (provider === "codex") State.setSemanticStatus(taskId, "A step needs attention");
        const detail = payload.tool_error ?? `tool ${payload.tool_status ?? "failed"}${payload.tool_exit_code != null ? ` (exit ${payload.tool_exit_code})` : ""}`;
        State.appendStep(taskId, `⚠ ${detail}`.slice(0, 140));
        State.setPillBadge(taskId, "error");
        Sound.play("error");
      } else {
        State.updateTask(taskId, "working");
      }
      break;
    }

    case "PostToolUseFailure":
    case "tool_result_failed":
      State.updateTask(taskId, "error", eventTime(payload.timestamp));
      if (provider === "codex") State.setSemanticStatus(taskId, "A step needs attention");
      State.appendStep(taskId, `⚠ ${payload.error ?? String(payload.tool_result?.error ?? "tool failed")}`.slice(0, 140));
      State.setPillBadge(taskId, "error");
      Sound.play("error");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(taskId, "ratelimit");
        if (provider === "codex") State.setSemanticStatus(taskId, "Waiting for rate limit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(taskId, "question");
        if (provider === "codex") State.setSemanticStatus(taskId, "Needs your input");
        else State.appendStep(taskId, message);
      }
      break;
    }

    case "Stop": {
      cancelApprovalForEvent(island, provider, sessionId, payload.turn_id);
      State.updateTask(taskId, "finished", eventTime(payload.timestamp));
      const message = payload.last_assistant_message ?? payload.message;
      if (provider === "codex") State.setSemanticStatus(taskId, conciseCompletion(message));
      else if (message) State.appendStep(taskId, message.slice(0, 120));
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(taskId, "finished");
      const runToken = runtime?.runToken;
      if (runtime) {
        if (runtime.finishTimer != null) window.clearTimeout(runtime.finishTimer);
        runtime.finishTimer = window.setTimeout(() => {
          runtime.finishTimer = null;
          if (runtime.runToken !== runToken) return;
          const current = State.tasks.find((candidate) => candidate.id === taskId);
          if (!current || current.state !== "finished") return;
          State.updateTask(taskId, "idle");
          State.setPillBadge(taskId, null);
        }, 5200);
      }
      break;
    }

    case "Interrupt":
    case "Interrupted":
      cancelApprovalForEvent(island, provider, sessionId, payload.turn_id);
      State.updateTask(taskId, "interrupted", eventTime(payload.timestamp));
      if (provider === "codex") State.setSemanticStatus(taskId, "Work stopped");
      State.appendStep(taskId, "Interrupted");
      State.setPillBadge(taskId, "interrupted");
      if (runtime?.finishTimer != null) window.clearTimeout(runtime.finishTimer);
      if (runtime) runtime.finishTimer = null;
      break;

    case "StopFailure":
      cancelApprovalForEvent(island, provider, sessionId, payload.turn_id);
      State.updateTask(taskId, "error", eventTime(payload.timestamp));
      if (provider === "codex") State.setSemanticStatus(taskId, "Task stopped with an error");
      else if (payload.error) State.appendStep(taskId, payload.error.slice(0, 120));
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(taskId, "error");
      break;

    case "SessionEnd":
      cancelApprovalForEvent(island, provider, sessionId, payload.turn_id, true);
      if (sessionId) {
        State.endGoal(taskId, eventTime(payload.timestamp));
        State.removeCodeSession(provider, sessionId);
      } else {
        State.updateTask(taskId, "idle");
        if (task) {
          task.steps = [];
          task.stepIndex = 0;
          task.stepRevision++;
          task.name = provider === "codex" ? "Codex" : "VS Code";
          task.pillBadge = null;
        }
      }
      break;

    case "SubagentStart":
      if (provider === "codex") State.setSemanticStatus(taskId, "Working with a subagent");
      else State.appendStep(taskId, "+ subagent");
      break;

    case "SubagentStop":
      if (provider === "codex") State.setSemanticStatus(taskId, "Subagent work complete");
      else State.appendStep(taskId, "• subagent done");
      break;

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      if (!requestId) break;
      const active = State.pendingApproval;
      if (active) {
        if (active.requestId === requestId) break;
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId,
        turnId: payload.turn_id ?? null,
        taskId,
        provider,
        tool,
        command: approvalTarget(tool, input),
      };
      State.setFocus(taskId);
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(taskId, "approval");
      if (provider === "codex") State.setSemanticStatus(taskId, "Waiting for approval");
      State.isPinned = true;
      Sound.play("approval");
      island.alert("approval");
      clearApprovalTimeout(requestId);
      const requestedTaskId = taskId;
      const requestedSessionId = sessionId;
      const requestedTurnId = payload.turn_id ?? null;
      const request = State.pendingApproval;
      let timer = 0;
      timer = window.setTimeout(() => {
        if (approvalTimers.get(requestId) === timer) approvalTimers.delete(requestId);
        if (State.pendingApproval !== request || request.requestId !== requestId) return;
        if (request.taskId !== requestedTaskId || request.sessionId !== requestedSessionId || request.turnId !== requestedTurnId) return;
        void Bridge.approvalDecline(requestId);
        State.appendStep(requestedTaskId, `Approval timed out; returned to ${providerName(request.provider)}`);
        clearPendingApproval(island, request);
        State.notify();
      }, 110_000);
      approvalTimers.set(requestId, timer);
      break;
    }

    default:
      break;
  }
  State.notify();
}
