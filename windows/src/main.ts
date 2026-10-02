// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { markUsageUnavailable, mergeCodexUsage, parseCodexUsage } from "./core/usage";
import { initializeChatSession, reconcileChatSession } from "./core/chat-session";
import { Island } from "./island/island";
import { declinePendingApproval, registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  initializeChatSession();
  island.applySettings();
  State.loadIntegrationTasks();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    if (on) declinePendingApproval(island);
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());
  await onEvent<null>("outside-click", () => island.dismissOutside());
  await onEvent<{ kind?: string; payload?: unknown; receivedAt?: number; requestStartedAt?: number | null; emittedAt?: number | null }>("codex-rate-limits", (event) => {
    const receivedAt = event.receivedAt ?? Date.now();
    if (event.kind === "unavailable") {
      State.setCodexUsage(markUsageUnavailable(State.codexUsage, receivedAt));
      return;
    }
    const meta = {
      source: event.kind === "updated" ? "notification" as const : "snapshot" as const,
      receivedAt,
      requestStartedAt: event.requestStartedAt ?? null,
      emittedAt: event.emittedAt ?? null,
    };
    const next = event.kind === "updated"
      ? mergeCodexUsage(State.codexUsage, event.payload, receivedAt, meta)
      : mergeCodexUsage(State.codexUsage, event.payload, receivedAt, meta) ?? parseCodexUsage(event.payload, receivedAt, meta);
    if (next) {
      const prior = State.codexUsage;
      State.setCodexUsage(next);
      const changed = prior?.fiveHour?.usedPercent !== next.fiveHour?.usedPercent || prior?.weekly?.usedPercent !== next.weekly?.usedPercent;
      if (changed || event.kind === "unavailable") {
        const detail = `Codex usage ${event.kind ?? "snapshot"}: 5h ${next.fiveHour?.usedPercent ?? "—"} used/${next.fiveHour?.windowDurationMins ?? "?"}m, week ${next.weekly?.usedPercent ?? "—"} used/${next.weekly?.windowDurationMins ?? "?"}m, source ${next.source ?? "?"}, received ${new Date(receivedAt).toISOString()}`;
        void Bridge.log(detail);
      }
    }
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    reconcileChatSession();
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);

  let previousExpanded: boolean | null = null;
  let previousActive: boolean | null = null;
  const previousTaskStates = new Map<string, string>();
  const syncUsageDemand = () => {
    const expanded = State.mode === "expanded";
    const activeStates = new Set(["working", "thinking", "searching"]);
    const active = State.tasks.some((task) => task.provider === "codex" && !task.isIntegration && activeStates.has(task.state));
    let finishedTurn = false;
    for (const task of State.tasks) {
      if (task.provider !== "codex" || task.isIntegration) continue;
      const previous = previousTaskStates.get(task.id);
      if (previous && activeStates.has(previous) && ["finished", "interrupted", "error"].includes(task.state)) finishedTurn = true;
      previousTaskStates.set(task.id, task.state);
    }
    for (const id of previousTaskStates.keys()) {
      if (!State.tasks.some((task) => task.id === id)) previousTaskStates.delete(id);
    }
    if (expanded !== previousExpanded || active !== previousActive) {
      void Bridge.setCodexUsageDemand(expanded, active);
      if (expanded && (!State.codexUsage || Date.now() - State.codexUsage.fetchedAt > 10_000)) void Bridge.refreshCodexUsage();
      previousExpanded = expanded;
      previousActive = active;
    }
    if (finishedTurn) void Bridge.refreshCodexUsage();
  };
  State.subscribe(syncUsageDemand);
  syncUsageDemand();
  void Bridge.refreshCodexUsage();

  if (!boot?.autoStarted) island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
