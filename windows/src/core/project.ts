export interface ProjectIdentity {
  projectName?: unknown;
  gitRemote?: unknown;
  gitRootName?: unknown;
  cwd?: unknown;
}

const ALIASES: Record<string, string> = {
  coucou: "Coucou",
  dropshiflow: "DropshiFlow",
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
};

function candidate(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (!name || /^(goal|task|session|turn)[-_]/i.test(name)) return "";
  return name.replace(/\.git$/i, "");
}

function humanize(value: string): string {
  const clean = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return ALIASES[clean.toLowerCase()] ?? clean.replace(/(^|\s)\p{L}/gu, (s) => s.toUpperCase());
}

/** Stable workspace label. Goal/session directory slugs are deliberately ignored. */
export function deriveProjectName(identity: ProjectIdentity): string {
  const remote = typeof identity.gitRemote === "string" ? identity.gitRemote.trim() : "";
  const remoteRepo = remote.match(/(?:[:/])([^/:]+?)(?:\.git)?$/i)?.[1] ?? "";
  const ordered = [remoteRepo, identity.projectName, identity.gitRootName, identity.cwd];
  for (const value of ordered) {
    const clean = candidate(value);
    if (clean) return humanize(clean);
  }
  return "Codex";
}
