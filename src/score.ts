/**
 * Blast Radius - the risk formula and tier mapping.
 *
 * Kept dependency-free (no vscode import) so it can be unit-checked headlessly
 * with scripts/check-risk.js - the numbers on screen come from exactly this code.
 */

export type RiskTier = "unused" | "low" | "medium" | "high" | "critical";
export type UsageStatus = "entry" | "active" | "exported-unused" | "unused";

/** Pokemon type colours, reused as the severity scale. */
export const TIER_COLORS: Record<RiskTier, string> = {
  unused: "#705898", // Ghost
  low: "#78C850", // Grass
  medium: "#F8D030", // Electric
  high: "#EE8130", // Fire
  critical: "#7C538C", // Fighting/Dark
};

export function tierFor(score: number): RiskTier {
  if (score < 0) {
    return "unused";
  }
  if (score < 15) {
    return "low";
  }
  if (score < 30) {
    return "medium";
  }
  if (score < 50) {
    return "high";
  }
  return "critical";
}

/**
 * THE RISK FORMULA - one place, deliberately simple and explainable.
 *
 *   score = fanIn * 2                  each caller is 2 points of blast radius
 *         + (100 - coveragePct) / 10   0% covered adds 10, 100% covered adds 0
 *         + churnCount                 one point per commit in the churn window
 *         - (busFactor > 1 ? 2 : 0)    more than one author who knows it: small discount
 *
 * Unknown coverage counts as 50% (+5) rather than assuming the worst.
 * Tweak the weights here and the CodeLens, hover and graph all follow.
 */
export function computeScore(input: {
  fanIn: number;
  coveragePct: number | null;
  churnCount: number;
  busFactor: number;
}): number {
  const coverage = input.coveragePct ?? 50;
  const raw =
    input.fanIn * 2 +
    (100 - coverage) / 10 +
    input.churnCount -
    (input.busFactor > 1 ? 2 : 0);
  return Math.max(0, Math.round(raw * 10) / 10);
}

/**
 * UNUSED CODE - nothing calls it, so there is no blast radius at all. Instead of a
 * risk score it gets a negative one, so it sorts apart and reads as "remove me":
 *
 *   score = -lines                     the lines you could delete
 *
 * "Unused" means no caller of any kind (see CallGraph.usageStatus): no call, no
 * callback, no JSX tag, and it is not an entry point, test or generated code.
 * Exported-unused gets the same score but a different label - something outside
 * this workspace might still import it.
 */
export function unusedScore(lines: number): number {
  return -Math.max(1, lines);
}

export interface RiskInput {
  fanIn: number;
  lines: number;
  usage: UsageStatus;
  coveragePct: number | null;
  churnCount: number;
  busFactor: number;
}

/** The inputs plus the result, so every view can show the arithmetic. */
export interface RiskBreakdown extends RiskInput {
  score: number;
  tier: RiskTier;
}

export function computeRisk(input: RiskInput): RiskBreakdown {
  const unused = input.usage === "unused" || input.usage === "exported-unused";
  const score = unused ? unusedScore(input.lines) : computeScore(input);
  return { ...input, score, tier: unused ? "unused" : tierFor(score) };
}

/** The arithmetic behind a score, as one line for tooltips and documents. */
export function formulaText(b: RiskBreakdown): string {
  if (b.usage === "unused" || b.usage === "exported-unused") {
    return `unused: 0 callers, so score = -lines = ${b.score}`;
  }
  return (
    `score = fanIn*2 + (100 - coverage)/10 + churn - (busFactor > 1 ? 2 : 0) = ` +
    `${b.fanIn}*2 + (100 - ${b.coveragePct ?? 50})/10 + ${b.churnCount} - ${b.busFactor > 1 ? 2 : 0} = ${b.score}`
  );
}
