/**
 * Blast Radius - lcov.info parsing.
 *
 * Dependency-free so it can be checked headlessly. Produces, per source file,
 * a map of 1-based line number to hit count, straight from the DA records.
 */
import * as path from "path";

export type LcovIndex = Map<string, Map<number, number>>;

export function parseLcov(root: string, text: string): LcovIndex {
  const index: LcovIndex = new Map();
  let current: Map<number, number> | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      const file = line.slice(3);
      const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
      current = index.get(abs) || new Map<number, number>();
      index.set(abs, current);
    } else if (line.startsWith("DA:") && current) {
      const [lineNo, hits] = line.slice(3).split(",");
      const n = Number(lineNo);
      const h = Number(hits);
      if (Number.isFinite(n) && Number.isFinite(h)) {
        current.set(n, Math.max(current.get(n) || 0, h));
      }
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }

  return index;
}

/**
 * Percentage of instrumented lines in [startLine, endLine] (0-based, inclusive)
 * that were hit. Returns null when the range has no instrumented lines at all.
 */
export function coverageForRange(
  index: LcovIndex,
  file: string,
  startLine: number,
  endLine: number,
): number | null {
  const lines = index.get(file);
  if (!lines) {
    return null;
  }
  let total = 0;
  let hit = 0;
  for (let line = startLine + 1; line <= endLine + 1; line++) {
    const hits = lines.get(line);
    if (hits === undefined) {
      continue; // not instrumented (blank, comment, closing brace)
    }
    total++;
    if (hits > 0) {
      hit++;
    }
  }
  if (total === 0) {
    return null;
  }
  return Math.round((hit / total) * 100);
}
