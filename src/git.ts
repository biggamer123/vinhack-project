/**
 * Blast Radius - per-function git history.
 *
 * One `git log -L <start>,<end>:<file>` call per function gives the commits that
 * actually touched that line range, with git following the range backwards
 * through edits. From a single call we derive both:
 *   - churn     = commits in the last 90 days
 *   - busFactor = distinct author emails, over all time
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface RangeCommit {
  hash: string;
  email: string;
  name: string;
  date: Date;
  /** Commit subject line, for the expandable history in the GIT tab. */
  subject: string;
}

export interface RangeHistory {
  commits: RangeCommit[];
  /** Commits within the churn window. */
  churnCount: number;
  /** Distinct author emails, all time. */
  busFactor: number;
  /** Authors by commit count, descending - Stage 5 uses this for reviewer suggestion. */
  authors: { name: string; email: string; commits: number }[];
  lastChange: Date | null;
}

export const CHURN_WINDOW_DAYS = 90;

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** ASCII unit separator: safe inside author names and emails. */
const SEP = String.fromCharCode(31);
const COMMIT_LINE = new RegExp(
  `^([0-9a-f]{7,40})${SEP}(.*?)${SEP}(.*?)${SEP}([^${SEP}]+)${SEP}(.*)$`
);

function run(cwd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

/** Absolute path of the repo root containing `dir`, or undefined if not a git repo. */
export async function findRepoRoot(dir: string): Promise<string | undefined> {
  try {
    const out = await run(dir, ['rev-parse', '--show-toplevel']);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * History for one function's line range. `startLine`/`endLine` are 0-based
 * (converted to git's 1-based here). Returns an empty history on any git error
 * - an untracked or brand-new file is a normal case, not a failure.
 */
export async function historyForRange(
  repoRoot: string,
  file: string,
  startLine: number,
  endLine: number
): Promise<RangeHistory> {
  const empty: RangeHistory = { commits: [], churnCount: 0, busFactor: 0, authors: [], lastChange: null };
  // git reports the repo root with symlinks resolved (/private/var on macOS,
  // for instance) while editor paths keep them. Compare real paths, or every
  // function in a symlinked checkout silently loses its history.
  const rel = path.relative(realPath(repoRoot), realPath(file));
  if (rel.startsWith('..')) {
    return empty;
  }

  let stdout: string;
  try {
    stdout = await run(repoRoot, [
      'log',
      '--no-color',
      `-L${startLine + 1},${endLine + 1}:${rel}`,
      `--format=%H${SEP}%ae${SEP}%an${SEP}%aI${SEP}%s`,
    ]);
  } catch {
    return empty;
  }

  const commits: RangeCommit[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = COMMIT_LINE.exec(line);
    if (!match) {
      continue; // diff body lines
    }
    const [, hash, email, name, iso, subject] = match;
    if (seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    commits.push({ hash, email, name, date: new Date(iso), subject: subject || "" });
  }

  return summarize(commits);
}

function summarize(commits: RangeCommit[]): RangeHistory {
  const cutoff = Date.now() - CHURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const byAuthor = new Map<string, { name: string; email: string; commits: number }>();
  let churnCount = 0;
  let lastChange: Date | null = null;

  for (const commit of commits) {
    if (commit.date.getTime() >= cutoff) {
      churnCount++;
    }
    if (!lastChange || commit.date > lastChange) {
      lastChange = commit.date;
    }
    const entry = byAuthor.get(commit.email);
    if (entry) {
      entry.commits++;
    } else {
      byAuthor.set(commit.email, { name: commit.name, email: commit.email, commits: 1 });
    }
  }

  const authors = [...byAuthor.values()].sort((a, b) => b.commits - a.commits);
  return { commits, churnCount, busFactor: authors.length, authors, lastChange };
}
