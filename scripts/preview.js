/**
 * Dev helper: bake the real graph + risk data into a standalone copy of the
 * webview and open it in a browser. Same HTML the extension serves - handy for
 * iterating on the visuals (or demoing) without the Extension Development Host.
 *
 *   npm run preview            # uses demo/
 *   node scripts/preview.js ~/some-repo
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { indexSource, initParser } = require("../out/indexer");
const { CallGraph } = require("../out/graph");
const { parseLcov, coverageForRange } = require("../out/lcov");
const { computeScore, tierFor } = require("../out/score");
const { findRepoRoot, historyForRange } = require("../out/git");
const { buildStandaloneHtml } = require("../out/standalone");

const root = path.resolve(process.argv[2] || "demo");
const SKIP = ["node_modules", "dist", "build", "out", ".git", "coverage"];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(js|jsx|mjs|cjs|ts|mts|cts|tsx)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

(async () => {
  await initParser(path.join(__dirname, ".."));
  const graph = new CallGraph();
  for (const f of walk(root))
    graph.setFile(f, indexSource(f, fs.readFileSync(f, "utf8")));
  graph.resolveEdges();

  const lcovPath = path.join(root, "coverage/lcov.info");
  const hasLcov = fs.existsSync(lcovPath);
  const lcov = hasLcov
    ? parseLcov(root, fs.readFileSync(lcovPath, "utf8"))
    : new Map();
  const repo = await findRepoRoot(root);

  const nodes = [];
  const edges = [];
  for (const n of graph.allNodes()) {
    const coveragePct = hasLcov
      ? coverageForRange(lcov, n.file, n.startLine, n.endLine)
      : null;
    const h = repo
      ? await historyForRange(repo, n.file, n.startLine, n.endLine)
      : null;
    const risk = {
      fanIn: n.callers.size,
      coveragePct,
      coverageIsProxy: !hasLcov,
      churnCount: h ? h.churnCount : 0,
      busFactor: h ? h.busFactor : 0,
      authors: h ? h.authors : [],
      lastChange: h && h.lastChange ? h.lastChange.getTime() : null,
      commits: h ? h.commits.slice(0, 50).map((c) => ({ email: c.email, t: c.date.getTime() })) : [],
      gitResolved: !!h,
    };
    const score = computeScore(risk);
    nodes.push({
      id: n.id,
      name: n.name,
      file: path.relative(root, n.file),
      startLine: n.startLine,
      fanIn: n.callers.size,
      fanOut: n.callees.size,
      score,
      tier: tierFor(score),
      risk,
    });
    for (const c of n.callees) edges.push({ from: n.id, to: c });
  }
  nodes.sort((a, b) => b.score - a.score);

  const summary =
    `${nodes.length} functions · ${edges.length} edges · ` +
    (hasLcov ? "lcov coverage" : "proxy coverage (no lcov.info)") +
    (repo ? "" : " · no git history");

  const template = fs.readFileSync(
    path.join(__dirname, "..", "media", "graph.html"),
    "utf8",
  );
  const html = buildStandaloneHtml(
    template,
    { type: "graph", nodes, edges, summary },
    new Date().toLocaleString(),
  );

  const out = path.join(os.tmpdir(), "blast-radius-preview.html");
  fs.writeFileSync(out, html);
  console.log(`${nodes.length} functions, ${edges.length} edges -> ${out}`);
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  execFile(opener, [out], (err) => {
    if (err) console.log("open it manually:", out);
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
