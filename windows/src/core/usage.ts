import type { CodexUsage, UsageWindow } from "./state";

type Obj = Record<string, unknown>;
const record = (v: unknown): Obj | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
const finite = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

function parseWindow(value: unknown): UsageWindow | undefined {
  const row = record(value);
  if (!row) return undefined;
  const used = finite(row.usedPercent);
  if (used === null) return undefined;
  return {
    usedPercent: used,
    remainingPercent: 100 - used,
    windowDurationMins: finite(row.windowDurationMins),
    resetsAt: finite(row.resetsAt),
  };
}

function rawWithoutAccountId(value: Obj): Obj {
  const raw = structuredClone(value);
  delete raw.accountId;
  return raw;
}

/** Parse the installed app-server's read response or updated notification. */
export function parseCodexUsage(input: unknown, fetchedAt = Date.now()): CodexUsage | null {
  const root = record(input);
  if (!root) return null;
  const result = record(root.result) ?? record(root.params) ?? root;
  const buckets = record(result.rateLimitsByLimitId);
  const selected = record(buckets?.codex) ?? record(result.rateLimits);
  if (!selected) return null;
  const primary = parseWindow(selected.primary);
  const secondary = parseWindow(selected.secondary);
  if (!primary && !secondary) return null;
  return {
    available: true,
    limitId: typeof selected.limitId === "string" ? selected.limitId : "codex",
    planType: typeof selected.planType === "string" ? selected.planType : null,
    primary,
    secondary,
    fetchedAt,
    raw: rawWithoutAccountId(result),
  };
}

function mergeWindow(previous: UsageWindow | undefined, update: unknown): UsageWindow | undefined {
  const row = record(update);
  if (!row) return previous;
  const used = finite(row.usedPercent) ?? previous?.usedPercent;
  if (used === undefined) return previous;
  return {
    usedPercent: used,
    remainingPercent: 100 - used,
    windowDurationMins: finite(row.windowDurationMins) ?? previous?.windowDurationMins ?? null,
    resetsAt: finite(row.resetsAt) ?? previous?.resetsAt ?? null,
  };
}

/** Sparse account/rateLimits/updated frames retain fields absent in the frame. */
export function mergeCodexUsage(previous: CodexUsage | null, input: unknown, fetchedAt = Date.now()): CodexUsage | null {
  const root = record(input);
  if (!root) return previous;
  const result = record(root.result) ?? record(root.params) ?? root;
  const buckets = record(result.rateLimitsByLimitId);
  const update = record(buckets?.codex) ?? record(result.rateLimits);
  if (!update) return previous;
  const parsed = parseCodexUsage(input, fetchedAt);
  const primary = mergeWindow(previous?.primary ?? parsed?.primary, update.primary);
  const secondary = mergeWindow(previous?.secondary ?? parsed?.secondary, update.secondary);
  if (!primary && !secondary) return previous;
  const rawPrev = record(previous?.raw) ?? {};
  const rawNext = rawWithoutAccountId(result);
  const oldBucket = record(rawPrev.rateLimits) ?? {};
  const nextBucket = record(rawNext.rateLimits) ?? update;
  const mergedRawBucket = { ...oldBucket, ...nextBucket };
  if (update.primary == null && oldBucket.primary) mergedRawBucket.primary = oldBucket.primary;
  if (update.secondary == null && oldBucket.secondary) mergedRawBucket.secondary = oldBucket.secondary;
  return {
    available: true,
    limitId: typeof update.limitId === "string" ? update.limitId : previous?.limitId ?? "codex",
    planType: typeof update.planType === "string" ? update.planType : previous?.planType ?? null,
    primary,
    secondary,
    fetchedAt,
    raw: { ...rawPrev, ...rawNext, rateLimits: mergedRawBucket },
  };
}

export function displayPercent(remainingPercent: number): number {
  return Math.min(100, Math.max(0, remainingPercent));
}

export function formatResetTime(resetsAt: number | null): string {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return "reset time unavailable";
  const date = new Date(resetsAt * 1000);
  if (Number.isNaN(date.getTime())) return "reset time unavailable";
  return `resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date)}`;
}
