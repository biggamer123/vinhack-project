/**
 * Blast Radius - the risk formula and tier mapping.
 *
 * Kept dependency-free (no vscode import) so it can be unit-checked headlessly
 * with scripts/check-risk.js - the numbers on screen come from exactly this code.
 */

export type RiskTier = "low" | "medium" | "high" | "critical";

/** Pokemon type colours, reused as the severity scale. */
export const TIER_COLORS: Record<RiskTier, string> = {
  low: "#78C850", // Grass
  medium: "#F8D030", // Electric
  high: "#EE8130", // Fire
  critical: "#7C538C", // Fighting/Dark
};

export function tierFor(score: number): RiskTier {
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
