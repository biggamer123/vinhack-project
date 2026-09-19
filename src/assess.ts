/**
 * Blast Radius - score one function from the graph plus its measured facts.
 *
 * The single place where graph structure (callers, usage) meets coverage and git
 * history, so the extension, the checks and the preview all compute a score the
 * same way. Dependency-free.
 */
import type { CallGraph, FunctionNode } from "./graph";
import { computeRisk, RiskBreakdown } from "./score";

export interface MeasuredFacts {
  coveragePct: number | null;
  coverageIsProxy: boolean;
  churnCount: number;
  busFactor: number;
  gitResolved: boolean;
}

export function assessFunction(graph: CallGraph, node: FunctionNode, facts: MeasuredFacts): RiskBreakdown {
  return computeRisk({
    fanIn: node.callers.size,
    lines: node.endLine - node.startLine + 1,
    usage: graph.usageStatus(node),
    coveragePct: facts.coveragePct,
    churnCount: facts.churnCount,
    busFactor: facts.busFactor,
  });
}
