/**
 * Dev helper: run the full Stage 1 + Stage 2 pipeline headlessly over a repo and
 * print every function's risk breakdown, so the numbers can be checked against
 * `git log` by hand without launching the Extension Development Host.
 *
 *   npm run compile && node scripts/check-risk.js demo
 */
const path = require("path");
const fs = require("fs");
const { indexSource, initParser } = require("../out/indexer");
const { CallGraph } = require("../out/graph");
const { parseLcov, coverageForRange } = require("../out/lcov");
const { assessFunction } = require("../out/assess");
const { findRepoRoot, historyForRange } = require("../out/git");

const root = path.resolve(process.argv[2] || ".");
const SKIP = ["node_modules", "dist", "build", "out", ".git", "coverage"];

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(js|jsx|mjs|cjs|ts|mts|cts|tsx|go)$/.test(entry.name))
      acc.push(full);
  }
  return acc;
}

(async () => {
  await initParser(path.join(__dirname, ".."));
  const graph = new CallGraph();
  for (const file of walk(root)) {
    graph.setFile(file, indexSource(file, fs.readFileSync(file, "utf8")));
  }
  graph.resolveEdges();

  const lcovPath = path.join(root, "coverage/lcov.info");
  const lcov = fs.existsSync(lcovPath)
    ? parseLcov(root, fs.readFileSync(lcovPath, "utf8"))
    : new Map();
  const repo = await findRepoRoot(root);

  console.log(`root=${root}`);
  console.log(
    `lcov=${fs.existsSync(lcovPath) ? lcovPath : "ABSENT (proxy mode)"}  git=${repo || "none"}`,
  );
  console.log(`${graph.size} functions, ${graph.callSiteCount} call sites\n`);

  const rows = [];
  for (const node of graph.allNodes()) {
    const coveragePct = lcov.size
      ? coverageForRange(lcov, node.file, node.startLine, node.endLine)
      : null;
    const history = repo
      ? await historyForRange(repo, node.file, node.startLine, node.endLine)
      : null;
    const churnCount = history ? history.churnCount : 0;
    const busFactor = history ? history.busFactor : 0;
    const b = assessFunction(graph, node, {
      coveragePct,
      coverageIsProxy: false,
      churnCount,
      busFactor,
      gitResolved: !!history,
    });
    rows.push({
      node,
      coveragePct,
      churnCount,
      busFactor,
      b,
      score: b.score,
      tier: b.tier,
    });
  }

  rows.sort((a, b) => b.score - a.score);
  console.log("SCORE  TIER      USAGE            FANIN COVER CHURN BUS LINES  FUNCTION");
  const line = (r) =>
    console.log(
      String(r.score).padStart(5),
      r.tier.padEnd(9),
      r.b.usage.padEnd(16),
      String(r.b.fanIn).padStart(5),
      String(r.b.coveragePct ?? "-").padStart(5),
      String(r.b.churnCount).padStart(5),
      String(r.b.busFactor).padStart(3),
      String(r.b.lines).padStart(5),
      " " + r.node.name + "  (" + path.relative(root, r.node.file) + ":" + (r.node.startLine + 1) + ")",
    );
  const limit = Number(process.env.ROWS || 1e9);
  rows.slice(0, limit).forEach(line);
  if (rows.length > limit) {
    console.log("  ...");
    rows.filter((r) => r.score < 0).forEach(line);
  }
  const counts = rows.reduce((acc, r) => ((acc[r.tier] = (acc[r.tier] || 0) + 1), acc), {});
  console.log("\ntiers:", counts);
})();
