/**
 * Blast Radius - local backups and the git command log.
 *
 * Backups are commits on refs/heads/blastradiusbackups, written by
 * media/hooks/backup.sh without touching HEAD, the index or the working tree.
 * They are taken on a timer by the extension and after every commit by a
 * post-commit hook, and a pre-push hook keeps the branch off every remote.
 *
 * The command log combines three sources, because git itself does not record
 * the commands people run:
 *   - the reflog: every command that moved HEAD (commit, reset, rebase, amend,
 *     checkout, merge, pull, cherry-pick, stash) with who and when
 *   - commands typed into VS Code terminals, captured through shell integration
 *   - events from this feature itself (push guard, enable/disable)
 *
 * Dependency-free (no vscode import) so scripts/check-backups.js can drive it
 * against real repositories.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { featureKey, parseCommitMessage } from "./features";

export const BACKUP_BRANCH = "blastradiusbackups";
export const BACKUP_REF = `refs/heads/${BACKUP_BRANCH}`;
export const HOOK_MARKER = "BLASTRADIUS-HOOK";
const HOOK_NAMES = ["pre-push", "post-commit"] as const;
type HookName = (typeof HOOK_NAMES)[number];

/* -------------------------------------------------------------------- git */

export function git(cwd: string, args: string[], input?: string): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export async function gitDirOf(repo: string): Promise<string | undefined> {
  const res = await git(repo, ["rev-parse", "--absolute-git-dir"]);
  return res.code === 0 ? res.stdout.trim() : undefined;
}

/* ------------------------------------------------------------------ hooks */

export interface HookStatus {
  /** Where git looks for hooks in this repository. */
  hooksDir: string;
  /** core.hooksPath is set (husky and friends): we do not write into a versioned hooks folder. */
  managedExternally: boolean;
  prePush: "installed" | "missing" | "foreign";
  postCommit: "installed" | "missing" | "foreign";
  /** Hooks that already existed and now run before ours. */
  chained: string[];
  scriptsPresent: boolean;
}

function wrapperFor(hook: HookName): string {
  const lines = [
    "#!/bin/sh",
    `# ${HOOK_MARKER}: ${hook} - installed by the Blast Radius VS Code extension.`,
    "# Remove it with the command \"Blast Radius: Disable Backups\"; any hook that was",
    `# here before lives next to it as ${hook}.blastradius-chained and is restored then.`,
    'BLASTRADIUS_HOOKS_DIR=$(cd "$(dirname "$0")" && pwd)',
    "export BLASTRADIUS_HOOKS_DIR",
    'BR_GIT_DIR=$(git rev-parse --absolute-git-dir)',
  ];
  if (hook === "pre-push") {
    lines.push('exec sh "$BR_GIT_DIR/blastradius/pre-push.sh" "$@"');
  } else {
    lines.push(
      'if [ -x "$BLASTRADIUS_HOOKS_DIR/post-commit.blastradius-chained" ]; then',
      '  "$BLASTRADIUS_HOOKS_DIR/post-commit.blastradius-chained" "$@"',
      "fi",
      "# In the background, so committing is never slowed down by a snapshot.",
      '( sh "$BR_GIT_DIR/blastradius/backup.sh" commit >/dev/null 2>&1 & )',
      "exit 0",
    );
  }
  return lines.join("\n") + "\n";
}

async function hooksDirOf(repo: string): Promise<{ dir: string; external: boolean }> {
  const configured = (await git(repo, ["config", "--get", "core.hooksPath"])).stdout.trim();
  const dir = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])).stdout.trim();
  return { dir, external: configured.length > 0 };
}

function hookState(dir: string, hook: HookName): "installed" | "missing" | "foreign" {
  const file = path.join(dir, hook);
  if (!fs.existsSync(file)) {
    return "missing";
  }
  return fs.readFileSync(file, "utf8").includes(HOOK_MARKER) ? "installed" : "foreign";
}

export async function hookStatus(repo: string): Promise<HookStatus> {
  const { dir, external } = await hooksDirOf(repo);
  const gitDir = (await gitDirOf(repo)) || "";
  return {
    hooksDir: dir,
    managedExternally: external,
    prePush: hookState(dir, "pre-push"),
    postCommit: hookState(dir, "post-commit"),
    chained: HOOK_NAMES.filter((h) => fs.existsSync(path.join(dir, `${h}.blastradius-chained`))),
    scriptsPresent: ["backup.sh", "pre-push.sh"].every((f) => fs.existsSync(path.join(gitDir, "blastradius", f))),
  };
}

/**
 * Copy the scripts into .git/blastradius and install the hooks. Existing hooks
 * are kept and chained, never overwritten. With core.hooksPath set the hooks
 * folder is usually committed to the repository, so nothing is written there -
 * the status says so and the UI explains how to add the guard by hand.
 */
export async function installBackupSupport(repo: string, extensionPath: string): Promise<HookStatus> {
  const gitDir = await gitDirOf(repo);
  if (!gitDir) {
    throw new Error("not a git repository");
  }
  const state = path.join(gitDir, "blastradius");
  fs.mkdirSync(state, { recursive: true });
  for (const script of ["backup.sh", "pre-push.sh"]) {
    const target = path.join(state, script);
    fs.copyFileSync(path.join(extensionPath, "media", "hooks", script), target);
    fs.chmodSync(target, 0o755);
  }

  const { dir, external } = await hooksDirOf(repo);
  if (!external) {
    fs.mkdirSync(dir, { recursive: true });
    for (const hook of HOOK_NAMES) {
      const file = path.join(dir, hook);
      const chained = path.join(dir, `${hook}.blastradius-chained`);
      if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(HOOK_MARKER)) {
        if (fs.existsSync(chained)) {
          throw new Error(`${hook} and ${hook}.blastradius-chained both exist - refusing to overwrite either`);
        }
        fs.renameSync(file, chained);
      }
      fs.writeFileSync(file, wrapperFor(hook));
      fs.chmodSync(file, 0o755);
    }
  }
  return hookStatus(repo);
}

/** Remove our hooks and put back whatever was there before. Backups are kept. */
export async function removeBackupSupport(repo: string): Promise<HookStatus> {
  const { dir, external } = await hooksDirOf(repo);
  if (!external) {
    for (const hook of HOOK_NAMES) {
      const file = path.join(dir, hook);
      const chained = path.join(dir, `${hook}.blastradius-chained`);
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(HOOK_MARKER)) {
        fs.rmSync(file);
      }
      if (fs.existsSync(chained) && !fs.existsSync(file)) {
        fs.renameSync(chained, file);
      }
    }
  }
  return hookStatus(repo);
}

/** The lines to add by hand when core.hooksPath points at a versioned folder. */
export function manualHookInstructions(): string {
  return [
    "# add to your pre-push hook:",
    'sh "$(git rev-parse --absolute-git-dir)/blastradius/pre-push.sh" "$@" || exit $?',
    "# add to your post-commit hook:",
    '( sh "$(git rev-parse --absolute-git-dir)/blastradius/backup.sh" commit >/dev/null 2>&1 & )',
  ].join("\n");
}

/* ---------------------------------------------------------------- backups */

export async function runBackup(
  repo: string,
  trigger: "interval" | "commit" | "manual" | "pre-restore",
  note = "",
): Promise<{ created: boolean; commit?: string; error?: string }> {
  const gitDir = await gitDirOf(repo);
  if (!gitDir) {
    return { created: false, error: "not a git repository" };
  }
  const script = path.join(gitDir, "blastradius", "backup.sh");
  if (!fs.existsSync(script)) {
    return { created: false, error: "backups are not enabled in this repository" };
  }
  const before = (await git(repo, ["rev-parse", "-q", "--verify", BACKUP_REF])).stdout.trim();
  const code = await new Promise<number>((resolve) => {
    execFile("sh", [script, trigger, note], { cwd: repo, timeout: 120000 }, (err) => {
      resolve(err ? 1 : 0);
    });
  });
  const after = (await git(repo, ["rev-parse", "-q", "--verify", BACKUP_REF])).stdout.trim();
  return {
    created: !!after && after !== before,
    commit: after || undefined,
    error: code === 0 ? undefined : "the backup script failed",
  };
}

export interface Backup {
  sha: string;
  t: number;
  trigger: string;
  head: string;
  branch: string;
  headSubject: string;
  uncommittedFiles: number;
  note: string;
  author: string;
  /** Change against the previous backup. */
  filesChanged: number;
  insertions: number;
  deletions: number;
  feature: { key: string; name: string; type: string } | null;
}

const RS = String.fromCharCode(30);
const US = String.fromCharCode(31);

function trailer(body: string, key: string): string {
  const match = new RegExp(`^${key}: ?(.*)$`, "m").exec(body);
  return match ? match[1].trim() : "";
}

function featureOf(subject: string): Backup["feature"] {
  const parsed = parseCommitMessage(subject);
  return parsed ? { key: featureKey(parsed), name: parsed.scope || parsed.title, type: parsed.type } : null;
}

export async function listBackups(repo: string, limit = 500): Promise<Backup[]> {
  const exists = (await git(repo, ["rev-parse", "-q", "--verify", BACKUP_REF])).code === 0;
  if (!exists) {
    return [];
  }
  const res = await git(repo, [
    "log",
    BACKUP_REF,
    `-n${limit}`,
    "--shortstat",
    `--format=${RS}%H${US}%an${US}%ct${US}%B${US}`,
  ]);
  const backups: Backup[] = [];
  for (const record of res.stdout.split(RS)) {
    if (!record.trim()) {
      continue;
    }
    const parts = record.split(US);
    if (parts.length < 5) {
      continue;
    }
    const [sha, author, ct, body, rest] = parts;
    const stat = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(rest || "");
    const headSubject = trailer(body, "Backup-Head-Subject");
    backups.push({
      sha,
      t: Number(ct) * 1000,
      trigger: trailer(body, "Backup-Trigger") || "manual",
      head: trailer(body, "Backup-Head"),
      branch: trailer(body, "Backup-Branch"),
      headSubject,
      uncommittedFiles: Number(trailer(body, "Backup-Uncommitted-Files")) || 0,
      note: trailer(body, "Backup-Note"),
      author,
      filesChanged: stat ? Number(stat[1]) : 0,
      insertions: stat && stat[2] ? Number(stat[2]) : 0,
      deletions: stat && stat[3] ? Number(stat[3]) : 0,
      feature: featureOf(headSubject),
    });
  }
  return backups;
}

/* ---------------------------------------------------------- restore help */

export interface RestoreCommands {
  preview: string;
  restore: string;
  exact: string;
  file: string;
}

/**
 * Copy-paste commands for getting back to a backup, from the repository root or
 * anywhere inside it, in a POSIX shell (macOS/Linux, or Git Bash on Windows).
 *
 * Every command that changes files first runs backup.sh pre-restore, which
 * refuses to continue unless the current state is safely saved - so a restore
 * shows up as a backup of its own and can be undone exactly the same way.
 * None of them move a branch or rewrite history: HEAD stays where it is and the
 * restored files are left for you to review and commit.
 */
export function restoreCommands(sha: string): RestoreCommands {
  const short = sha.slice(0, 12);
  const safety = `sh "$(git rev-parse --absolute-git-dir)/blastradius/backup.sh" pre-restore "before restoring ${short}"`;
  const restore = `git restore --source=${short} --staged --worktree -- :/`;
  return {
    preview: `git diff --stat ${short} -- :/`,
    restore: `${safety} && ${restore}`,
    exact: `${safety} && ${restore} && git clean -fd -- :/`,
    file: `git restore --source=${short} -- <path>`,
  };
}

/* ------------------------------------------------------------ command log */

export type Risk = "destructive" | "rewrite" | "remote" | "moves-head" | "safe";

export interface Classification {
  op: string;
  risk: Risk;
  why: string;
}

const COMMAND_RULES: { re: RegExp; op: string; risk: Risk; why: string }[] = [
  { re: /\breset\b.*--hard\b/, op: "reset --hard", risk: "destructive", why: "discards uncommitted changes and can drop commits" },
  { re: /\bclean\b.*\s-[a-zA-Z]*f/, op: "clean", risk: "destructive", why: "permanently deletes untracked files" },
  { re: /\bcheckout\b(.*\s)?--\s|\bcheckout\s+\.(\s|$)/, op: "checkout --", risk: "destructive", why: "overwrites working tree files" },
  { re: /\brestore\b(?!.*--staged\b(?!.*--worktree))/, op: "restore", risk: "destructive", why: "overwrites working tree files" },
  { re: /\bstash\s+(drop|clear)\b/, op: "stash drop", risk: "destructive", why: "deletes stashed work" },
  { re: /\bbranch\s+(-D\b|.*--delete\s+--force|.*-d\s+-f\b)/, op: "branch -D", risk: "destructive", why: "deletes a branch even if unmerged" },
  { re: /\b(reflog\s+expire|gc\b.*--prune)/, op: "prune", risk: "destructive", why: "removes the history that makes recovery possible" },
  { re: /\bpush\b.*(--force\b|--force-with-lease|\s-f\b|\s\+\S+)/, op: "push --force", risk: "rewrite", why: "rewrites history on the remote" },
  { re: /\brebase\b/, op: "rebase", risk: "rewrite", why: "rewrites commits" },
  { re: /\bcommit\b.*--amend\b/, op: "commit --amend", risk: "rewrite", why: "replaces the last commit" },
  { re: /\b(filter-branch|filter-repo)\b/, op: "filter-branch", risk: "rewrite", why: "rewrites history" },
  { re: /\breset\b/, op: "reset", risk: "rewrite", why: "moves the branch pointer" },
  { re: /\bpush\b/, op: "push", risk: "remote", why: "publishes commits" },
  { re: /\b(pull|merge)\b/, op: "pull/merge", risk: "remote", why: "brings in other changes" },
  { re: /\b(checkout|switch)\b/, op: "checkout", risk: "moves-head", why: "changes what is checked out" },
];

/** Classify a command typed into a terminal. Returns null for non-git commands. */
export function classifyGitCommand(commandLine: string): Classification | null {
  const text = commandLine.trim().replace(/\s+/g, " ");
  if (!/^git(\s|$)/.test(text)) {
    return null;
  }
  for (const rule of COMMAND_RULES) {
    if (rule.re.test(text)) {
      return { op: rule.op, risk: rule.risk, why: rule.why };
    }
  }
  const sub = text.split(" ")[1] || "git";
  return { op: sub, risk: "safe", why: "" };
}

/** Classify a reflog entry by its message ("reset: moving to HEAD~2", ...). */
export function classifyReflog(message: string): Classification {
  const m = message.trim();
  if (/^commit \(amend\)/.test(m)) return { op: "commit --amend", risk: "rewrite", why: "replaced the previous commit" };
  if (/^commit( \((initial|merge)\))?:/.test(m)) return { op: "commit", risk: "safe", why: "" };
  if (/^reset: /.test(m)) return { op: "reset", risk: "destructive", why: "moved the branch - commits or changes may have been dropped" };
  if (/^rebase/.test(m)) return { op: "rebase", risk: "rewrite", why: "rewrote commits" };
  if (/^checkout: /.test(m)) return { op: "checkout", risk: "moves-head", why: "switched what was checked out" };
  if (/^pull/.test(m)) return { op: "pull", risk: "remote", why: "brought in remote changes" };
  if (/^merge /.test(m)) return { op: "merge", risk: "remote", why: "merged another branch" };
  if (/^cherry-pick/.test(m)) return { op: "cherry-pick", risk: "safe", why: "" };
  if (/^revert/.test(m)) return { op: "revert", risk: "safe", why: "" };
  if (/^(WIP on|On ) /.test(m)) return { op: "stash", risk: "safe", why: "" };
  if (/^branch: /.test(m)) return { op: "branch", risk: "safe", why: "" };
  if (/^clone: /.test(m)) return { op: "clone", risk: "safe", why: "" };
  return { op: m.split(":")[0] || "update", risk: "safe", why: "" };
}

export interface ReflogEntry {
  sha: string;
  t: number;
  message: string;
  name: string;
  email: string;
  subject: string;
  ref: string;
}

export async function readReflog(repo: string, limit = 400): Promise<ReflogEntry[]> {
  const entries: ReflogEntry[] = [];
  for (const ref of ["HEAD", "refs/stash"]) {
    if ((await git(repo, ["rev-parse", "-q", "--verify", ref])).code !== 0) {
      continue;
    }
    const res = await git(repo, [
      "log",
      "-g",
      "--date=unix",
      `-n${limit}`,
      `--format=${RS}%H${US}%gd${US}%gs${US}%gn${US}%ge${US}%s`,
      ref,
    ]);
    for (const record of res.stdout.split(RS)) {
      const line = record.replace(/\s+$/, "");
      if (!line) {
        continue;
      }
      const [sha, gd, gs, name, email, subject] = line.split(US);
      const at = /@\{(\d+)\}/.exec(gd || "");
      entries.push({
        sha,
        t: at ? Number(at[1]) * 1000 : 0,
        message: gs || "",
        name: name || "",
        email: email || "",
        subject: subject || "",
        ref,
      });
    }
  }
  return entries;
}

/* ----------------------------------------------------------------- events */

export interface LoggedEvent {
  t: number;
  kind: "terminal" | "push-guard" | "enabled" | "disabled";
  command?: string;
  exitCode?: number | null;
  cwd?: string;
  name?: string;
  email?: string;
  head?: string;
  remote?: string;
  others?: number;
  status?: number;
}

export function eventsFile(gitDir: string): string {
  return path.join(gitDir, "blastradius", "events.jsonl");
}

export function appendEvent(gitDir: string, event: LoggedEvent): void {
  fs.mkdirSync(path.join(gitDir, "blastradius"), { recursive: true });
  fs.appendFileSync(eventsFile(gitDir), JSON.stringify(event) + "\n");
}

export function readEvents(gitDir: string, limit = 2000): LoggedEvent[] {
  const file = eventsFile(gitDir);
  if (!fs.existsSync(file)) {
    return [];
  }
  const events: LoggedEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      // a torn write from a hook racing the extension - skip that line
    }
  }
  return events.slice(-limit);
}

/* --------------------------------------------------------------- timeline */

export interface TimelineEntry {
  t: number;
  source: "terminal" | "reflog" | "backup" | "push-guard" | "setup";
  title: string;
  detail: string;
  who: string;
  risk: Risk;
  why: string;
  exitCode?: number | null;
  sha?: string;
  subject?: string;
  feature: { key: string; name: string; type: string } | null;
  /** The newest backup taken before this happened: the place to go back to. */
  restorePoint: { sha: string; t: number } | null;
  backupSha?: string;
}

/**
 * Merge every source into one newest-first timeline, and tie each entry to the
 * backup that preceded it and to the feature its commit belongs to.
 */
export function buildTimeline(backups: Backup[], reflog: ReflogEntry[], events: LoggedEvent[]): TimelineEntry[] {
  const oldestFirst = backups.slice().sort((a, b) => a.t - b.t);
  const restorePointBefore = (t: number): TimelineEntry["restorePoint"] => {
    let found: Backup | null = null;
    for (const b of oldestFirst) {
      if (b.t <= t) {
        found = b;
      } else {
        break;
      }
    }
    return found ? { sha: found.sha, t: found.t } : null;
  };

  const entries: TimelineEntry[] = [];

  for (const r of reflog) {
    const c = classifyReflog(r.message);
    entries.push({
      t: r.t,
      source: "reflog",
      title: r.message,
      detail: r.ref === "HEAD" ? "" : r.ref,
      who: r.name ? `${r.name} <${r.email}>` : r.email,
      risk: c.risk,
      why: c.why,
      sha: r.sha,
      subject: r.subject,
      feature: c.op.startsWith("commit") ? featureOf(r.subject) : null,
      restorePoint: restorePointBefore(r.t),
    });
  }

  for (const e of events) {
    if (e.kind === "terminal" && e.command) {
      const c = classifyGitCommand(e.command) || { op: "git", risk: "safe" as Risk, why: "" };
      entries.push({
        t: e.t,
        source: "terminal",
        title: e.command,
        detail: e.cwd || "",
        who: e.name ? `${e.name} <${e.email || ""}>` : e.email || "",
        risk: c.risk,
        why: c.why,
        exitCode: e.exitCode,
        sha: e.head,
        feature: null,
        restorePoint: restorePointBefore(e.t),
      });
    } else if (e.kind === "push-guard") {
      entries.push({
        t: e.t,
        source: "push-guard",
        title: `push to ${e.remote || "remote"} - backup branch withheld`,
        detail: e.others
          ? e.status === 0
            ? "every other ref was pushed"
            : `pushing the other refs failed (exit ${e.status})`
          : "nothing else was being pushed",
        who: "",
        risk: "safe",
        why: "",
        feature: null,
        restorePoint: null,
      });
    } else if (e.kind === "enabled" || e.kind === "disabled") {
      entries.push({
        t: e.t,
        source: "setup",
        title: e.kind === "enabled" ? "backups enabled" : "backups disabled",
        detail: "",
        who: e.name || "",
        risk: "safe",
        why: "",
        feature: null,
        restorePoint: null,
      });
    }
  }

  for (const b of backups) {
    entries.push({
      t: b.t,
      source: "backup",
      title: `backup (${b.trigger})`,
      detail: `${b.branch || "?"} @ ${b.head.slice(0, 8)} - ${b.uncommittedFiles} uncommitted file${b.uncommittedFiles === 1 ? "" : "s"}`,
      who: b.author,
      risk: "safe",
      why: "",
      sha: b.head,
      subject: b.headSubject,
      feature: b.feature,
      restorePoint: null,
      backupSha: b.sha,
    });
  }

  return entries.sort((a, b) => b.t - a.t);
}
