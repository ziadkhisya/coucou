import type { CodexUsage, UsageWindow } from "./state";

type Obj = Record<string, unknown>;
export type UsageSource = "snapshot" | "notification";
export type UsageFreshness = "fresh" | "stale" | "unavailable";

export interface UsageUpdateMeta {
  source?: UsageSource;
  receivedAt?: number;
  requestStartedAt?: number | null;
  emittedAt?: number | null;
}

const record = (value: unknown): Obj | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function epochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function findEmittedAt(...values: unknown[]): number | null {
  for (const value of values) {
    const row = record(value);
    if (!row) continue;
    for (const key of ["emittedAt", "updatedAt", "timestamp"]) {
      const parsed = epochMs(row[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  const row = record(value);
  if (!row) return value;
  return Object.fromEntries(Object.entries(row)
    .filter(([key]) => !["accountId", "account_id", "apiKey", "accessToken"].includes(key))
    .map(([key, child]) => [key, sanitize(child)]));
}

function selectedBucket(result: Obj): Obj | null {
  const byId = record(result.rateLimitsByLimitId);
  if (byId) {
    const codex = record(byId.codex);
    if (codex) return codex;
    const candidates = Object.values(byId).map(record).filter((value): value is Obj => value !== null);
    const identified = candidates.find((candidate) => candidate.limitId === "codex");
    if (identified) return identified;
  }
  return record(result.rateLimits);
}

interface ParsedWindow extends UsageWindow { key: string }

function parseWindows(bucket: Obj, receivedAt: number, meta: UsageUpdateMeta, previous: CodexUsage | null): { fiveHour?: UsageWindow; weekly?: UsageWindow } {
  const raw = record(previous?.raw) ?? {};
  const oldById = record(raw.rateLimitsByLimitId);
  const oldBucket = record(oldById?.codex) ?? record(raw.rateLimits);
  const rows: ParsedWindow[] = [];
  for (const key of ["primary", "secondary", "fiveHour", "weekly"]) {
    const oldWindow = record(oldBucket?.[key]);
    const oldDuration = finite(oldWindow?.windowDurationMins);
    const priorWindow = oldDuration === 300 ? previous?.fiveHour : oldDuration === 10_080 ? previous?.weekly : undefined;
    const parsed = parseWindow(bucket[key], key, bucket, receivedAt, meta, oldDuration ?? priorWindow?.windowDurationMins ?? null, oldWindow, priorWindow);
    if (parsed) rows.push(parsed);
  }
  const array = Array.isArray(bucket.windows) ? bucket.windows : [];
  array.forEach((value, index) => {
    const parsed = parseWindow(value, `window-${index + 1}`, bucket, receivedAt, meta);
    if (parsed) rows.push(parsed);
  });

  // Duration is authoritative: Codex may reorder primary/secondary or use named windows.
  let fiveHour = rows.find((window) => window.windowDurationMins === 300);
  let weekly = rows.find((window) => window.windowDurationMins === 10_080);
  // Older schema variants omit durations. Fall back to field names only when no duration was supplied.
  const hasDuration = rows.some((window) => window.windowDurationMins !== null);
  if (!hasDuration) {
    fiveHour ??= rows.find((window) => window.key === "primary" || window.key === "fiveHour");
    weekly ??= rows.find((window) => window.key === "secondary" || window.key === "weekly");
  }
  return {
    ...(fiveHour ? { fiveHour: stripKey(fiveHour) } : {}),
    ...(weekly ? { weekly: stripKey(weekly) } : {}),
  };
}

function parseWindow(value: unknown, key: string, bucket: Obj, receivedAt: number, meta: UsageUpdateMeta, fallbackDuration: number | null = null, oldValue: Obj | null = null, previous?: UsageWindow): ParsedWindow | undefined {
  const row = record(value);
  if (!row) return undefined;
  if (!["usedPercent", "windowDurationMins", "resetsAt", "limitId"].some((field) => row[field] !== undefined)) return undefined;
  const used = finite(row.usedPercent) ?? finite(oldValue?.usedPercent) ?? previous?.usedPercent ?? null;
  if (used === null) return undefined;
  return {
    key,
    usedPercent: used,
    remainingPercent: 100 - used,
    windowDurationMins: finite(row.windowDurationMins) ?? fallbackDuration,
    resetsAt: finite(row.resetsAt) ?? finite(oldValue?.resetsAt) ?? previous?.resetsAt ?? null,
    limitId: typeof row.limitId === "string" ? row.limitId : typeof bucket.limitId === "string" ? bucket.limitId : null,
    source: meta.source ?? "snapshot",
    receivedAt,
    emittedAt: meta.emittedAt ?? null,
    requestStartedAt: meta.requestStartedAt ?? null,
  };
}

function stripKey(window: ParsedWindow): UsageWindow {
  const { key: _key, ...rest } = window;
  return rest;
}

function unwrap(input: unknown): { root: Obj; result: Obj; bucket: Obj } | null {
  const root = record(input);
  if (!root) return null;
  const payload = record(root.payload);
  const envelope = payload ?? root;
  const result = record(envelope.result) ?? record(envelope.params) ?? envelope;
  const bucket = selectedBucket(result);
  return bucket ? { root: envelope, result, bucket } : null;
}

export function parseCodexUsage(input: unknown, receivedAt = Date.now(), meta: UsageUpdateMeta = {}): CodexUsage | null {
  return parseCodexUsageInternal(input, receivedAt, meta, null);
}

function parseCodexUsageInternal(input: unknown, receivedAt: number, meta: UsageUpdateMeta, previous: CodexUsage | null): CodexUsage | null {
  const unwrapped = unwrap(input);
  if (!unwrapped) return null;
  const source = meta.source ?? (unwrapped.root.method === "account/rateLimits/updated" ? "notification" : "snapshot");
  const emittedAt = meta.emittedAt ?? findEmittedAt(unwrapped.root, unwrapped.result, unwrapped.bucket);
  const enrichedMeta = { ...meta, source, emittedAt };
  const windows = parseWindows(unwrapped.bucket, receivedAt, enrichedMeta, previous);
  if (!windows.fiveHour && !windows.weekly) return null;
  const isSnapshot = source === "snapshot";
  return {
    available: true,
    limitId: typeof unwrapped.bucket.limitId === "string" ? unwrapped.bucket.limitId : "codex",
    planType: typeof unwrapped.bucket.planType === "string" ? unwrapped.bucket.planType : null,
    ...windows,
    source,
    fetchedAt: receivedAt,
    lastFullReadAt: isSnapshot ? receivedAt : null,
    lastRollingUpdateAt: isSnapshot ? null : receivedAt,
    lastErrorAt: null,
    raw: sanitize(unwrapped.result),
    error: null,
  };
}

function newerThan(window: UsageWindow | undefined, emittedAt: number | null, receivedAt: number): boolean {
  if (!window) return true;
  if (emittedAt !== null && window.emittedAt !== null) return emittedAt >= window.emittedAt;
  return receivedAt >= window.receivedAt;
}

/**
 * Merge a full read or rolling notification without allowing an in-flight older
 * read to overwrite a notification or a more recently received full snapshot.
 */
export function mergeCodexUsage(
  previous: CodexUsage | null,
  input: unknown,
  receivedAt = Date.now(),
  meta: UsageUpdateMeta = {},
): CodexUsage | null {
  const parsed = parseCodexUsageInternal(input, receivedAt, meta, previous);
  if (!parsed) return previous;
  const source = parsed.source ?? "snapshot";
  const emittedAt = meta.emittedAt ?? parsed.fiveHour?.emittedAt ?? parsed.weekly?.emittedAt ?? null;
  const requestStartedAt = meta.requestStartedAt ?? parsed.fiveHour?.requestStartedAt ?? parsed.weekly?.requestStartedAt ?? null;

  if (source === "snapshot" && previous) {
    const newestNotification = previous.lastRollingUpdateAt ?? 0;
    const newestSnapshot = previous.lastFullReadAt ?? 0;
    const newerReceive = Math.max(newestNotification, newestSnapshot);
    if (requestStartedAt !== null && newerReceive > requestStartedAt && (emittedAt === null || emittedAt < newerReceive)) return previous;
    if (requestStartedAt === null && newerReceive > receivedAt) return previous;
  }

  if (source === "snapshot" || !previous?.available) return parsed;

  const fiveHour = newerThan(previous.fiveHour, emittedAt, receivedAt) ? parsed.fiveHour ?? previous.fiveHour : previous.fiveHour;
  const weekly = newerThan(previous.weekly, emittedAt, receivedAt) ? parsed.weekly ?? previous.weekly : previous.weekly;
  if (!fiveHour && !weekly) return previous;
  return {
    ...previous,
    available: true,
    limitId: parsed.limitId ?? previous.limitId,
    planType: parsed.planType ?? previous.planType,
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    source: "notification",
    fetchedAt: receivedAt,
    lastRollingUpdateAt: receivedAt,
    lastErrorAt: null,
    raw: { ...(record(previous.raw) ?? {}), ...(record(parsed.raw) ?? {}) },
    error: null,
  };
}

export function markUsageUnavailable(previous: CodexUsage | null, receivedAt = Date.now()): CodexUsage {
  if (previous?.available) return { ...previous, error: "unavailable", lastErrorAt: receivedAt };
  return { available: false, source: "unavailable", fetchedAt: receivedAt, lastFullReadAt: previous?.lastFullReadAt ?? null, lastRollingUpdateAt: previous?.lastRollingUpdateAt ?? null, lastErrorAt: receivedAt, error: "unavailable" };
}

export function usageFreshness(usage: CodexUsage | null, now = Date.now()): UsageFreshness {
  if (!usage?.available) return "unavailable";
  if (usage.error || now - usage.fetchedAt > 120_000) return "stale";
  return "fresh";
}

export type UsageSeverity = "healthy" | "warning" | "critical";
export function usageSeverity(remainingPercent: number): UsageSeverity {
  const shown = displayPercent(remainingPercent);
  return shown < 15 ? "critical" : shown <= 40 ? "warning" : "healthy";
}

export function displayPercent(remainingPercent: number): number {
  return Math.round(Math.min(100, Math.max(0, remainingPercent)));
}

export function formatResetTime(resetsAt: number | null): string {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return "reset time unavailable";
  const date = new Date(resetsAt * 1000);
  if (Number.isNaN(date.getTime())) return "reset time unavailable";
  return `resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date)}`;
}
