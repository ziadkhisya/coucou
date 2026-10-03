// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { compactTaskTitle, formatTaskDuration, taskElapsedMs } from "../core/timer";
import { sessionRailContent } from "../core/session-rail";
import { displayPercent, formatResetTime, usageFreshness, usageSeverity } from "../core/usage";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function providerLabel(task: AgentTask | null): string {
  if (task?.source === "codex") return "Codex";
  if (task?.source === "claudeCode") return "Claude Code";
  return "n8n";
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const projectName = h("div", { class: "session-name" });
  const taskTimer = h("span", { class: "task-timer" });
  const taskTitle = h("div", { class: "task-title" });
  const usageFiveHour = h("span", { class: "usage-window" });
  const usageDivider = h("span", { class: "usage-divider", text: "·" });
  const usageWeekly = h("span", { class: "usage-window" });
  const usageFreshnessLabel = h("span", { class: "usage-freshness" });
  const usageSummary = h("span", { class: "usage-summary", "aria-label": "Codex account usage" },
    usageFiveHour, usageDivider, usageWeekly, usageFreshnessLabel);
  const who = h("div", { class: "session-provider" });
  const sessionState = h("span", { class: "session-state" });
  const activityCount = h("span", { class: "session-count" });
  const meta = h("div", { class: "session-meta" }, who, h("span", { class: "meta-separator", text: "·" }), sessionState, activityCount);
  const checklist = h("div", { class: "codex-progress", "aria-live": "polite" });
  const taskLine = h("div", { class: "task-line" }, taskTitle, usageSummary);
  const tickerBody = h("div", { class: "card-body" }, h("div", { class: "project-line" }, projectName, taskTimer), taskLine, meta, checklist, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "session-list", tabindex: 0, "aria-label": "Other active Codex sessions" });
  const railTitle = h("div", { class: "session-rail-title", text: "OTHER SESSIONS" });
  const right = card(null, h("div", { class: "session-rail" }, railTitle, pills));
  const rightColumn = h("div", { class: "right" }, right);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    rightColumn,
  );

  let pillIds = "";
  let pillOrder = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "session" | "card" | null = null;
  let cardKey = "";
  let progressRows: HTMLElement[] = [];
  let progressMarkers: HTMLElement[] = [];
  let progressTexts: HTMLElement[] = [];
  let semanticRow: HTMLElement | null = null;
  let semanticDot: HTMLElement | null = null;
  let semanticText: HTMLElement | null = null;
  let planMore: HTMLElement | null = null;
  let completionNote: HTMLElement | null = null;
  let lastTimerSecond = -1;
  let lastRailTimerSecond = -1;

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "session" && State.focusTask?.provider !== "codex") ticker.tick(nowMs);
      const focused = State.focusTask;
      if (mode === "session" && focused?.provider === "codex" && focused.taskStartedAt != null) {
        const elapsed = taskElapsedMs(focused);
        const second = Math.floor((elapsed ?? 0) / 1000);
        if (second !== lastTimerSecond) {
          lastTimerSecond = second;
          taskTimer.textContent = formatTaskDuration(elapsed);
        }
      }
      if (State.mode === "expanded" && mode === "session") {
        const second = Math.floor(Date.now() / 1000);
        if (second !== lastRailTimerSecond) {
          lastRailTimerSecond = second;
          for (const pill of pills.querySelectorAll<HTMLButtonElement>(".session-pill")) {
            const task = State.tasks.find((item) => item.id === pill.dataset.taskId);
            const timer = pill.querySelector<HTMLElement>(".session-pill-timer");
            if (!task || !timer) continue;
            const summary = sessionRailContent(task);
            const next = summary.timer;
            if (timer.textContent !== next) timer.textContent = next;
            timer.style.display = task.taskStartedAt == null ? "none" : "";
            if (pill.title !== summary.title) pill.title = summary.title;
            const label = `Focus ${summary.title}`;
            if (pill.getAttribute("aria-label") !== label) pill.setAttribute("aria-label", label);
          }
        }
      }
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
        clear(checklist);
        progressRows = [];
        progressMarkers = [];
        progressTexts = [];
        semanticRow = semanticDot = semanticText = planMore = completionNote = null;
      }

      // Live Claude Code and Codex sessions get their own ticker. Provider
      // setup cards remain available when no session is focused.
      const isCodeSession = task?.source === "claudeCode" || task?.source === "codex";
      const sessionActive = Boolean(task && isCodeSession && !task.isIntegration);
      el.classList.toggle("codex-session", Boolean(task?.source === "codex" && !task.isIntegration));

      if (task && sessionActive) {
        if (mode !== "session") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "session";
          cardKey = "";
          progressRows = [];
          progressMarkers = [];
          progressTexts = [];
          semanticRow = semanticDot = semanticText = planMore = completionNote = null;
        }
        tickerBody.classList.toggle("session-done", task.state === "finished" || task.state === "interrupted");
        clear(projectName);
        projectName.title = task.name;
        projectName.append(dot(task.color, 7), h("span", { class: "session-name-text", text: task.name, title: task.name }));
        const visibleTaskTitle = compactTaskTitle(task.taskTitle);
        taskTitle.textContent = visibleTaskTitle;
        taskTitle.title = task.taskTitle || visibleTaskTitle;
        taskTitle.style.display = "";
        const elapsed = taskElapsedMs(task);
        taskTimer.textContent = formatTaskDuration(elapsed);
        taskTimer.style.display = task.taskStartedAt == null ? "none" : "";
        lastTimerSecond = elapsed == null ? -1 : Math.floor(elapsed / 1000);
        const usage = State.codexUsage;
        const previewClock = (globalThis as typeof globalThis & { __COUCOU_PREVIEW_NOW?: number }).__COUCOU_PREVIEW_NOW;
        const usageNow = previewClock ?? Date.now();
        const freshness = usageFreshness(usage, usageNow);
        const five = usage?.fiveHour;
        const week = usage?.weekly;
        const setWindow = (node: HTMLElement, label: string, window: typeof five) => {
          node.textContent = `${label} ${usage?.available && window ? `${displayPercent(window.remainingPercent)}%` : "—"}`;
          node.className = `usage-window ${window ? `usage-${usageSeverity(window.remainingPercent)}` : "usage-unavailable"}${freshness === "stale" ? " usage-stale" : ""}`;
          node.title = window ? `${label} ${displayPercent(window.remainingPercent)}% left · ${formatResetTime(window.resetsAt)}` : `${label} usage unavailable`;
        };
        setWindow(usageFiveHour, "5h", five);
        setWindow(usageWeekly, "Week", week);
        usageDivider.style.display = "";
        usageWeekly.style.display = "";
        usageFreshnessLabel.textContent = freshness === "unavailable" ? "Usage unavailable"
          : freshness === "stale" ? `Updated ${formatUsageAge(usageNow - (usage?.fetchedAt ?? usageNow))} ago` : "";
        usageFreshnessLabel.className = `usage-freshness ${freshness}`;
        usageFreshnessLabel.style.display = freshness === "fresh" ? "none" : "";
        usageSummary.title = freshness === "unavailable" ? "Codex account usage unavailable"
          : [
            five ? `5h ${displayPercent(five.remainingPercent)}% left · ${formatResetTime(five.resetsAt)}` : "5h usage unavailable",
            week ? `Week ${displayPercent(week.remainingPercent)}% left · ${formatResetTime(week.resetsAt)}` : "Weekly usage unavailable",
            freshness === "stale" ? `Last updated ${formatUsageAge(usageNow - (usage?.fetchedAt ?? usageNow))} ago` : "",
          ].filter(Boolean).join("\n");
        clear(who);
        who.append(h("span", { class: "provider-name", text: providerLabel(task) }));
        sessionState.textContent = task.state === "approval" ? "Needs approval"
          : task.state === "working" ? "Working"
          : task.state === "thinking" ? "Thinking"
          : task.state === "searching" ? "Searching"
          : task.state === "finished" ? "Finished"
          : task.state === "interrupted" ? "Stopped"
          : task.state === "error" ? "Error"
          : task.state === "question" ? "Needs input"
          : task.state === "ratelimit" ? "Rate limited"
          : "Connected";
        sessionState.className = `session-state ${task.state}`;
        if (task.provider === "codex") {
          activityCount.textContent = task.hasStructuredPlan ? `${task.completedPlanCount} / ${task.totalPlanCount} steps complete` : "";
          ticker.el.style.display = "none";
          checklist.style.display = "flex";
          syncCodexProgress(task, checklist, {
            get rows() { return progressRows; }, set rows(value) { progressRows = value; },
            get markers() { return progressMarkers; }, set markers(value) { progressMarkers = value; },
            get texts() { return progressTexts; }, set texts(value) { progressTexts = value; },
            get semanticRow() { return semanticRow; }, set semanticRow(value) { semanticRow = value; },
            get semanticDot() { return semanticDot; }, set semanticDot(value) { semanticDot = value; },
            get semanticText() { return semanticText; }, set semanticText(value) { semanticText = value; },
            get planMore() { return planMore; }, set planMore(value) { planMore = value; },
            get completionNote() { return completionNote; }, set completionNote(value) { completionNote = value; },
          });
        } else {
          activityCount.textContent = Math.max(task.stepRevision, task.steps.length) > 0
            ? `${Math.max(task.stepRevision, task.steps.length)} actions` : "";
          checklist.style.display = "none";
          ticker.el.style.display = "";
          ticker.sync(task);
        }
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const others = State.otherTasks;
      el.classList.toggle("has-sessions", others.length > 0);
      el.classList.toggle("single-other-session", others.length === 1);
      rightColumn.style.display = others.length === 0 ? "none" : "";
      const nextOrder = others.map((t) => t.id).join("|");
      const pillKey = others.map((t) => `${t.id}:${t.name}:${t.state}:${t.pillBadge ?? ""}:${t.completedPlanCount}:${t.totalPlanCount}:${t.currentStatus}:${t.taskTitle}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
        pruneMiniBots();
      }
      if (nextOrder !== pillOrder) pills.scrollTop = 0;
      pillOrder = nextOrder;
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const canvas = createMiniBot(task, 20);
  const summary = sessionRailContent(task);
  const title = summary.title;
  const pill = h(
    "button",
    { class: "session-pill", type: "button", title, onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "session-pill-copy" },
      h("span", { class: "session-pill-name-row" },
        h("span", { class: "session-pill-name", text: task.name, title: task.name }),
        h("span", { class: "session-pill-timer", text: summary.timer }),
      ),
      h("span", { class: "session-pill-state", text: summary.status, title: summary.status }),
    ),
  );
  pill.dataset.taskId = task.id;
  pill.setAttribute("aria-label", `Focus ${title}`);
  pill.style.setProperty("--session-color", task.color);
  pill.style.borderColor = `${task.color}24`;

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", interrupted: "#F0A64A", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, interrupted: ICONS.pause, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

type ProgressNodes = {
  rows: HTMLElement[];
  markers: HTMLElement[];
  texts: HTMLElement[];
  semanticRow: HTMLElement | null;
  semanticDot: HTMLElement | null;
  semanticText: HTMLElement | null;
  planMore: HTMLElement | null;
  completionNote: HTMLElement | null;
};

function syncCodexProgress(task: AgentTask, parent: HTMLElement, nodes: ProgressNodes) {
  const steps = task.hasStructuredPlan ? task.planSteps.slice(0, 6) : [];
  if (steps.length === 0) {
    for (const row of nodes.rows) row.remove();
    nodes.rows.length = nodes.markers.length = nodes.texts.length = 0;
    nodes.planMore?.remove();
    nodes.planMore = null;
    nodes.completionNote?.remove();
    nodes.completionNote = null;
    if (!nodes.semanticRow) {
      nodes.semanticDot = h("span", { class: "semantic-dot" });
      nodes.semanticText = h("span", { class: "semantic-status-text" });
      nodes.semanticRow = h("div", { class: "semantic-status-row" }, nodes.semanticDot, nodes.semanticText);
      parent.append(nodes.semanticRow);
    }
    nodes.semanticDot!.className = `semantic-dot ${task.state}`;
    nodes.semanticText!.textContent = task.currentStatus || (task.state === "finished" ? "Task finished" : "Reviewing project context");
    return;
  }

  nodes.semanticRow?.remove();
  nodes.semanticRow = nodes.semanticDot = nodes.semanticText = null;
  while (nodes.rows.length > steps.length) {
    nodes.rows.pop()!.remove();
    nodes.markers.pop();
    nodes.texts.pop();
  }
  for (let index = 0; index < steps.length; index++) {
    let row = nodes.rows[index];
    let marker = nodes.markers[index];
    let text = nodes.texts[index];
    if (!row || !marker || !text) {
      marker = h("span", { class: "plan-marker" });
      text = h("span", { class: "plan-text" });
      row = h("div", {}, marker, text);
      nodes.rows[index] = row;
      nodes.markers[index] = marker;
      nodes.texts[index] = text;
      parent.insertBefore(row, nodes.planMore ?? nodes.completionNote);
    }
    const step = steps[index];
    const status = step.status === "in_progress" ? "in_progress" : step.status;
    const label = status === "completed" ? "Completed" : status === "in_progress" ? "In progress" : "Upcoming";
    row.className = `plan-row ${status}`;
    row.title = step.text;
    row.setAttribute("aria-label", `${label}: ${step.text}`);
    marker.textContent = status === "completed" ? "✓" : status === "in_progress" ? "●" : "○";
    text.textContent = step.text;
    text.title = step.text;
  }
  if (task.planSteps.length > 6) {
    if (!nodes.planMore) {
      nodes.planMore = h("div", { class: "plan-more" });
    }
    parent.insertBefore(nodes.planMore, nodes.completionNote);
    nodes.planMore.textContent = `+${task.planSteps.length - 6} more steps`;
  } else {
    nodes.planMore?.remove();
    nodes.planMore = null;
  }
  const pending = task.planSteps.filter((step) => step.status === "pending").length;
  if (task.state === "finished" && pending > 0) {
    if (!nodes.completionNote) {
      nodes.completionNote = h("div", { class: "plan-completion-note" });
      parent.append(nodes.completionNote);
    }
    nodes.completionNote.textContent = `Turn finished · ${pending} ${pending === 1 ? "step" : "steps"} still pending`;
  } else {
    nodes.completionNote?.remove();
    nodes.completionNote = null;
  }
}

function formatUsageAge(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  return minutes < 1 ? "moments" : `${minutes}m`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const ask = btn("Ask Claude", "primary", () => actions.setView("prompt"));
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    ask,
  );
  return {
    el: h("div", { class: "view" }, card(null, body)),
    sync() { ask.querySelector("span")!.textContent = `Ask ${State.settings.chatProvider === "codex" ? "Codex" : "Claude"}`; },
  };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, `${providerLabel(State.focusTask)} · needs permission`));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      code.title = code.textContent;
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const task = State.focusTask;
      who.append(agentWho(task, `${providerLabel(task)} is asking a question`));
      title.textContent = task?.steps.at(-1) ?? `${providerLabel(task)} needs an answer.`;
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — Coucou can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, providerLabel(task)));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : `${providerLabel(task)} stopped on an error.`;
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const open = btn("Open terminal", "primary", () => actions.openTerminal());
  const row = h("div", { class: "actions" },
    open,
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      const codexSession = task?.source === "codex" && !task.isIntegration;
      open.querySelector("span")!.textContent = codexSession ? "Open folder" : "Open terminal";
      open.title = codexSession ? "Opens this session folder in VS Code." : "";
      clear(who);
      who.append(agentWho(task, `${providerLabel(task)} finished`));
      title.textContent = task?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const codexBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      codexBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude hooks" }),
      );
      clear(codexBadge);
      codexBadge.append(
        dot(State.integrations.integration_codex?.configured ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Codex hooks" }),
      );
      clear(apiBadge);
      apiBadge.append(
        dot(s.chatProvider === "codex" ? "#35A67A" : "#F5A524", 6),
        h("span", { text: `Chat · ${s.chatProvider === "codex" ? "Codex" : "Claude"}` }),
      );
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}

