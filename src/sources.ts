/**
 * Blast Radius - function source excerpts for browser snapshots.
 *
 * Dependency-free (fs only) so the preview script bakes exactly what the
 * extension's Open in Browser bakes.
 */
import * as fs from "fs";
import type { CallGraph } from "./graph";

/**
 * Each function's source, for the browser snapshot: there is no editor to open,
 * so clicking a function shows its code in the page. Capped per function and in
 * total so a large repo still produces a page that loads quickly.
 */
export function functionSources(graph: CallGraph): Record<string, { start: number; lines: string[]; truncated: boolean }> {
  const out: Record<string, { start: number; lines: string[]; truncated: boolean }> = {};
  const files = new Map<string, string[] | null>();
  let budget = 2_500_000;
  for (const node of graph.allNodes().sort((a, b) => b.callers.size - a.callers.size)) {
    if (budget <= 0) break;
    let lines = files.get(node.file);
    if (lines === undefined) {
      try {
        lines = fs.readFileSync(node.file, "utf8").split(/\r?\n/);
      } catch {
        lines = null;
      }
      files.set(node.file, lines);
    }
    if (!lines) continue;
    const wanted = node.endLine - node.startLine + 1;
    const take = Math.min(wanted, 160);
    const slice = lines.slice(node.startLine, node.startLine + take);
    budget -= slice.reduce((n, l) => n + l.length + 1, 0);
    out[node.id] = { start: node.startLine, lines: slice, truncated: take < wanted };
  }
  return out;
}

