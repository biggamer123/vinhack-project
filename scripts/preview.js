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
const { PROTOCOL_VERSION } = require("../out/protocol");

// schema.ts talks to the vscode API; stub the few calls it makes so the preview
// can bake real schema data in exactly like the extension's browser export does.
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      Uri: { file: (p) => ({ fsPath: p }) },
      workspace: {
        findFiles: async () => [],
        fs: { readFile: async (u) => fs.readFileSync(u.fsPath) },
        asRelativePath: (p) => path.relative(root, p),
        workspaceFolders: [{ uri: { fsPath: root } }],
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const root = path.resolve(process.argv[2] || "demo");
const SKIP = ["node_modules", "dist", "build", "out", ".git", "coverage"];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(js|jsx|mjs|cjs|ts|mts|cts|tsx|go)$/.test(e.name)) acc.push(full);
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
      commits: h
        ? h.commits.slice(0, 50).map((c) => ({
            hash: c.hash.slice(0, 8),
            email: c.email,
            name: c.name,
            t: c.date.getTime(),
            subject: c.subject,
          }))
        : [],
      gitResolved: !!h,
    };
    const score = computeScore(risk);
    nodes.push({
      id: n.id,
      name: n.name,
      file: path.relative(root, n.file),
      startLine: n.startLine,
      endLine: n.endLine,
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
  const { scanDatabaseSchemas, inferSchemaRelations } = require("../out/schema");
  // Features, built the same way the extension's browser export builds them.
  const { readCommits, buildFeatures } = require("../out/features");
  let features = null;
  if (repo) {
    const refs = nodes.map((n) => ({
      id: n.id,
      name: n.name,
      file: n.file,
      startLine: n.startLine,
      score: n.score,
      tier: n.tier,
      commitHashes: (n.risk.commits || []).map((c) => c.hash),
    }));
    features = buildFeatures(await readCommits(repo), refs);
    console.log(`features: ${features.features.length} from ${features.taggedCommits}/${features.totalCommits} commits`);
  }

  // Backups + command log, read-only, the same shape the extension sends.
  const bk = require("../out/backups");
  let backupsPayload = null;
  if (repo) {
    const gitDir = await bk.gitDirOf(repo);
    const list = await bk.listBackups(repo);
    const status = await bk.hookStatus(repo);
    backupsPayload = {
      available: true,
      enabled: status.prePush === "installed" || status.postCommit === "installed",
      branch: bk.BACKUP_BRANCH,
      intervalMinutes: 10,
      lastBackupAt: list.length ? list[0].t : null,
      nextBackupAt: null,
      hooks: status,
      manualInstructions: bk.manualHookInstructions(),
      terminalCapture: true,
      backups: list.map((b) => ({ ...b, commands: bk.restoreCommands(b.sha) })),
      timeline: bk.buildTimeline(list, await bk.readReflog(repo), bk.readEvents(gitDir)),
    };
    console.log(`backups: ${list.length}, timeline events: ${backupsPayload.timeline.length}`);
  }

  const scan = await scanDatabaseSchemas(root);
  const schema = {
    tables: scan.schemas.map((t) => ({
      name: t.name,
      kind: t.kind,
      source: path.relative(root, t.source),
      fields: t.fields,
    })),
    relations: inferSchemaRelations(scan.schemas),
    filesScanned: scan.filesScanned,
    usedFallback: scan.usedFallback,
    root,
    error: scan.error,
  };
  console.log(`schemas: ${schema.tables.length} tables, ${schema.relations.length} relations`);

  const html = buildStandaloneHtml(
    template,
    { type: "graph", nodes, edges, summary, schema, features, backups: backupsPayload, protocol: PROTOCOL_VERSION, version: "preview" },
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
