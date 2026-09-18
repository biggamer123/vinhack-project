/**
 * Blast Radius - features view.
 *
 * Reads commit messages written in a light convention and presents the codebase
 * as features instead of commits:
 *
 *   feature: get users from db
 *   bug fix: users list crashes on empty page
 *   refactor(users): split the repository layer
 *
 * Commits that share a title - or a scope, when one is given - become one
 * feature. Which functions belong to a feature is not guessed from file names:
 * it comes from the per-function `git log -L` history already gathered for risk
 * scoring, so a function is listed only if that feature's commits actually
 * changed its lines.
 *
 * Dependency-free (no vscode import) so scripts/check-features.js can verify it
 * against a real repository.
 */
import { execFile } from "child_process";

/* ------------------------------------------------------------------ types */

/** Canonical commit types, in the order the UI lists them. */
export const COMMIT_TYPES = [
  "feature",
  "bug fix",
  "hotfix",
  "refactor",
  "performance",
  "security",
  "test",
  "docs",
  "style",
  "chore",
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

/** Every spelling accepted for each type. Matched case-insensitively. */
const TYPE_ALIASES: Record<string, CommitType> = {
  feature: "feature",
  feat: "feature",
  features: "feature",
  "bug fix": "bug fix",
  bugfix: "bug fix",
  "bug-fix": "bug fix",
  fix: "bug fix",
  bug: "bug fix",
  hotfix: "hotfix",
  "hot fix": "hotfix",
  refactor: "refactor",
  refactoring: "refactor",
  perf: "performance",
  performance: "performance",
  security: "security",
  sec: "security",
  test: "test",
  tests: "test",
  docs: "docs",
  doc: "docs",
  documentation: "docs",
  style: "style",
  ui: "style",
  chore: "chore",
  build: "chore",
  ci: "chore",
};

export interface ParsedMessage {
  type: CommitType;
  scope: string | null;
  title: string;
  breaking: boolean;
}

export interface TaggedCommit extends ParsedMessage {
  hash: string;
  author: string;
  email: string;
  t: number;
  files: string[];
}

export interface RawCommit {
  hash: string;
  author: string;
  email: string;
  t: number;
  subject: string;
  files: string[];
}

/** What the features view needs to know about one function. */
export interface FunctionRef {
  id: string;
  name: string;
  file: string;
  startLine: number;
  score: number;
  tier: string;
  /** Short hashes of commits that touched this function's lines. */
  commitHashes: string[];
}

export interface Feature {
  key: string;
  name: string;
  scope: string | null;
  /** The type that best describes the feature: "feature" if any commit says so. */
  primaryType: CommitType;
  typeCounts: Partial<Record<CommitType, number>>;
  commits: {
    hash: string;
    type: CommitType;
    title: string;
    author: string;
    email: string;
    t: number;
    files: string[];
    breaking: boolean;
  }[];
  authors: { name: string; email: string; commits: number }[];
  files: { path: string; commits: number }[];
  functions: { id: string; name: string; file: string; startLine: number; score: number; tier: string }[];
  firstChange: number;
  lastChange: number;
}

export interface FeaturesPayload {
  features: Feature[];
  people: {
    name: string;
    email: string;
    commits: number;
    features: { key: string; name: string; primaryType: CommitType; commits: number }[];
  }[];
  totalCommits: number;
  taggedCommits: number;
  untagged: { hash: string; subject: string; author: string; t: number }[];
  /** How many functions had git history available to match against. */
  functionsWithHistory: number;
  functionsTotal: number;
  types: readonly CommitType[];
  error?: string;
}

/* ---------------------------------------------------------------- parsing */

/**
 * `type: title`, `type(scope): title`, or `type!: title` (breaking).
 * The type may contain one space ("bug fix") - anything longer is treated as
 * ordinary prose so "Merge pull request: ..." does not become a feature.
 */
const MESSAGE_RE = /^\s*([A-Za-z][A-Za-z-]*(?: [A-Za-z-]+)?)\s*(?:\(([^)]{1,60})\))?\s*(!)?\s*:\s*(\S.*)$/;

export function parseCommitMessage(subject: string): ParsedMessage | null {
  const match = MESSAGE_RE.exec(subject || "");
  if (!match) {
    return null;
  }
  const [, rawType, rawScope, bang, rawTitle] = match;
  const type = TYPE_ALIASES[rawType.trim().toLowerCase().replace(/\s+/g, " ")];
  if (!type) {
    return null;
  }
  const title = rawTitle.trim().replace(/[.\s]+$/, "");
  if (!title) {
    return null;
  }
  const scope = rawScope ? rawScope.trim() : null;
  return { type, scope: scope || null, title, breaking: !!bang };
}

/** Grouping key: the scope when there is one, otherwise the normalised title. */
export function featureKey(parsed: ParsedMessage): string {
  if (parsed.scope) {
    return "scope:" + parsed.scope.toLowerCase();
  }
  return "title:" + parsed.title.toLowerCase().replace(/\s+/g, " ");
}

/* -------------------------------------------------------------------- git */

const RS = String.fromCharCode(30);
const US = String.fromCharCode(31);

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 20000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

/** Every non-merge commit (newest first) with the files it changed. */
export async function readCommits(repoRoot: string, limit = 3000): Promise<RawCommit[]> {
  const out = await git(repoRoot, [
    "log",
    "--no-merges",
    "--no-color",
    `-n${limit}`,
    "--name-only",
    `--format=${RS}%H${US}%an${US}%ae${US}%aI${US}%s`,
  ]);
  return parseLogOutput(out);
}

export function parseLogOutput(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const record of out.split(RS)) {
    if (!record.trim()) {
      continue;
    }
    const lines = record.split(/\r?\n/);
    const header = lines[0].split(US);
    if (header.length < 5) {
      continue;
    }
    const [hash, author, email, iso, ...subjectParts] = header;
    const t = new Date(iso).getTime();
    commits.push({
      hash,
      author,
      email,
      t: Number.isFinite(t) ? t : 0,
      subject: subjectParts.join(US),
      files: lines
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean),
    });
  }
  return commits;
}

/* --------------------------------------------------------------- grouping */

export function buildFeatures(commits: RawCommit[], functions: FunctionRef[]): FeaturesPayload {
  // short hash -> functions whose line ranges that commit changed
  const touched = new Map<string, FunctionRef[]>();
  let functionsWithHistory = 0;
  for (const fn of functions) {
    if (fn.commitHashes.length) {
      functionsWithHistory++;
    }
    for (const hash of fn.commitHashes) {
      const key = hash.slice(0, 8);
      const list = touched.get(key);
      if (list) {
        list.push(fn);
      } else {
        touched.set(key, [fn]);
      }
    }
  }

  const groups = new Map<string, Feature>();
  const untagged: FeaturesPayload["untagged"] = [];
  let tagged = 0;

  for (const commit of commits) {
    const parsed = parseCommitMessage(commit.subject);
    if (!parsed) {
      untagged.push({ hash: commit.hash.slice(0, 8), subject: commit.subject, author: commit.author, t: commit.t });
      continue;
    }
    tagged++;
    const key = featureKey(parsed);
    let feature = groups.get(key);
    if (!feature) {
      feature = {
        key,
        name: parsed.scope || parsed.title,
        scope: parsed.scope,
        primaryType: parsed.type,
        typeCounts: {},
        commits: [],
        authors: [],
        files: [],
        functions: [],
        firstChange: commit.t,
        lastChange: commit.t,
      };
      groups.set(key, feature);
    }
    feature.typeCounts[parsed.type] = (feature.typeCounts[parsed.type] || 0) + 1;
    feature.commits.push({
      hash: commit.hash.slice(0, 8),
      type: parsed.type,
      title: parsed.title,
      author: commit.author,
      email: commit.email,
      t: commit.t,
      files: commit.files,
      breaking: parsed.breaking,
    });
    feature.firstChange = Math.min(feature.firstChange, commit.t);
    feature.lastChange = Math.max(feature.lastChange, commit.t);
  }

  const features = [...groups.values()].map((feature) => finalize(feature, touched));
  features.sort((a, b) => b.lastChange - a.lastChange);

  // who worked on what
  const people = new Map<string, FeaturesPayload["people"][number]>();
  for (const feature of features) {
    for (const author of feature.authors) {
      let person = people.get(author.email);
      if (!person) {
        person = { name: author.name, email: author.email, commits: 0, features: [] };
        people.set(author.email, person);
      }
      person.commits += author.commits;
      person.features.push({
        key: feature.key,
        name: feature.name,
        primaryType: feature.primaryType,
        commits: author.commits,
      });
    }
  }
  const peopleList = [...people.values()].sort((a, b) => b.commits - a.commits);
  for (const person of peopleList) {
    person.features.sort((a, b) => b.commits - a.commits);
  }

  return {
    features,
    people: peopleList,
    totalCommits: commits.length,
    taggedCommits: tagged,
    untagged: untagged.slice(0, 200),
    functionsWithHistory,
    functionsTotal: functions.length,
    types: COMMIT_TYPES,
  };
}

function finalize(feature: Feature, touched: Map<string, FunctionRef[]>): Feature {
  // A feature is a feature if anyone ever called it one; otherwise its most common type.
  if (feature.typeCounts.feature) {
    feature.primaryType = "feature";
  } else {
    let best: CommitType = feature.primaryType;
    let bestCount = -1;
    for (const type of COMMIT_TYPES) {
      const count = feature.typeCounts[type] || 0;
      if (count > bestCount) {
        best = type;
        bestCount = count;
      }
    }
    feature.primaryType = best;
  }

  const authors = new Map<string, { name: string; email: string; commits: number }>();
  const files = new Map<string, number>();
  const fns = new Map<string, Feature["functions"][number]>();

  for (const commit of feature.commits) {
    const author = authors.get(commit.email) || { name: commit.author, email: commit.email, commits: 0 };
    author.commits++;
    authors.set(commit.email, author);

    for (const file of commit.files) {
      files.set(file, (files.get(file) || 0) + 1);
    }
    for (const fn of touched.get(commit.hash.slice(0, 8)) || []) {
      if (!fns.has(fn.id)) {
        fns.set(fn.id, {
          id: fn.id,
          name: fn.name,
          file: fn.file,
          startLine: fn.startLine,
          score: fn.score,
          tier: fn.tier,
        });
      }
    }
  }

  feature.commits.sort((a, b) => b.t - a.t);
  // Name a title-grouped feature the way it was introduced, not how its latest
  // commit happened to spell it.
  if (!feature.scope && feature.commits.length) {
    feature.name = feature.commits[feature.commits.length - 1].title;
  }
  feature.authors = [...authors.values()].sort((a, b) => b.commits - a.commits);
  feature.files = [...files.entries()]
    .map(([path, commits]) => ({ path, commits }))
    .sort((a, b) => b.commits - a.commits || a.path.localeCompare(b.path));
  feature.functions = [...fns.values()].sort((a, b) => b.score - a.score);
  return feature;
}
