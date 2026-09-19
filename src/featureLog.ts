/**
 * Blast Radius - the shared feature log.
 *
 * Every commit can belong to a feature. A commit message in the convention
 * (`feature(comments): ...`) says so by itself; for every other commit the
 * answer is recorded in a file that is committed with the code, so everyone
 * working on the repository sees the same features:
 *
 *   .blastradius/FEATURES.md
 *
 * The file is ordinary Markdown - a heading per feature, a table of its commits -
 * so it reads fine on GitHub and in a diff, and can be edited by hand:
 *
 *   ## Threaded comments
 *
 *   - Type: feature
 *
 *   | commit | date | who | summary |
 *   | --- | --- | --- | --- |
 *   | a1b2c3d4 | 2026-09-12 | Ada Reyes | reply chains on posts |
 *
 * Dependency-free (no vscode import), so scripts/check-features.js can drive it.
 */
import * as fs from "fs";
import * as path from "path";
import { COMMIT_TYPES, CommitType } from "./features";

export const FEATURE_LOG_DIR = ".blastradius";
export const FEATURE_LOG_FILE = "FEATURES.md";
export const FEATURE_LOG_PATH = `${FEATURE_LOG_DIR}/${FEATURE_LOG_FILE}`;

export interface LoggedCommit {
  /** Short hash, 8 characters, as written in the file. */
  hash: string;
  date: string;
  who: string;
  summary: string;
}

export interface LoggedFeature {
  name: string;
  type: CommitType;
  commits: LoggedCommit[];
}

const HEADER = [
  "# Features",
  "",
  "Which commit belongs to which feature, so Blast Radius can group them even when the",
  "commit message does not follow the `feature(scope): title` convention.",
  "",
  "Written by the Blast Radius extension when you commit, and safe to edit by hand.",
  "Commit this file: everyone working on the repository then sees the same features.",
  "",
];

const ROW = /^\|\s*([0-9a-f]{7,40})\s*\|([^|]*)\|([^|]*)\|([\s\S]*?)\|\s*$/i;
const TYPE_LINE = /^-\s*Type:\s*(.+?)\s*$/i;

export function parseFeatureLog(text: string): LoggedFeature[] {
  const features: LoggedFeature[] = [];
  let current: LoggedFeature | undefined;

  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { name: heading[1], type: "feature", commits: [] };
      features.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const type = TYPE_LINE.exec(line);
    if (type) {
      const named = COMMIT_TYPES.find((t) => t === type[1].trim().toLowerCase());
      if (named) {
        current.type = named;
      }
      continue;
    }
    const row = ROW.exec(line);
    if (row && !/^-+$/.test(row[2].trim())) {
      current.commits.push({
        hash: row[1].toLowerCase().slice(0, 8),
        date: row[2].trim(),
        who: row[3].trim(),
        summary: row[4].trim(),
      });
    }
  }
  return features.filter((f) => f.name.toLowerCase() !== "features");
}

export function formatFeatureLog(features: LoggedFeature[]): string {
  const out = [...HEADER];
  for (const feature of features) {
    if (!feature.commits.length) {
      continue;
    }
    out.push(`## ${feature.name}`, "", `- Type: ${feature.type}`, "");
    out.push("| commit | date | who | summary |", "| --- | --- | --- | --- |");
    for (const c of feature.commits) {
      out.push(`| ${c.hash} | ${c.date} | ${cell(c.who)} | ${cell(c.summary)} |`);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/** Pipes and newlines would break the table row they sit in. */
function cell(value: string): string {
  return String(value || "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Add a commit to a feature, creating the feature when it is new. The same
 * commit never appears twice: tagging it again moves it.
 */
export function addToFeatureLog(
  features: LoggedFeature[],
  featureName: string,
  commit: LoggedCommit,
  type: CommitType = "feature",
): LoggedFeature[] {
  const hash = commit.hash.toLowerCase().slice(0, 8);
  const next = features.map((f) => ({ ...f, commits: f.commits.filter((c) => c.hash !== hash) }));
  const name = featureName.trim();
  let feature = next.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!feature) {
    feature = { name, type, commits: [] };
    next.push(feature);
  }
  // Newest first; a commit tagged today sorts above the ones already dated today.
  feature.commits.unshift({ ...commit, hash });
  feature.commits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return next.filter((f) => f.commits.length);
}

/**
 * Short hash -> the feature it was tagged with. Hashes are written at whatever
 * length the tool that wrote them used, so every prefix from 7 characters up is
 * a key and a lookup finds the row whichever length it has.
 */
export function taggedCommits(features: LoggedFeature[]): Map<string, { name: string; type: CommitType }> {
  const map = new Map<string, { name: string; type: CommitType }>();
  for (const feature of features) {
    for (const commit of feature.commits) {
      const value = { name: feature.name, type: feature.type };
      for (let len = 7; len <= commit.hash.length; len++) {
        map.set(commit.hash.slice(0, len), value);
      }
    }
  }
  return map;
}

/** The tags recorded in a repository, for the features view. Empty when there are none. */
export function readFeatureTags(root: string): Map<string, { name: string; type: CommitType }> {
  try {
    const file = path.join(root, FEATURE_LOG_PATH);
    return fs.existsSync(file) ? taggedCommits(parseFeatureLog(fs.readFileSync(file, "utf8"))) : new Map();
  } catch {
    return new Map();
  }
}
