/**
 * Dev helper: verify the LLM Markdown documents against a real repository.
 *
 *   npm run compile && node scripts/check-llm.js            # fixture repo, with assertions
 *   node scripts/check-llm.js ~/some-repo out-dir           # write every feature doc for a real repo
 *
 * The fixture has two features that call into each other and a caller outside
 * both, so the "called from outside the feature" section has something real to
 * find. Documents are built the same way the extension builds them.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { indexSource, initParser } = require("../out/indexer");
const { CallGraph } = require("../out/graph");
const { findRepoRoot, historyForRange } = require("../out/git");
const { readCommits, buildFeatures } = require("../out/features");
const { computeScore, tierFor } = require("../out/score");
const llm = require("../out/llmContext");

let failures = 0;
function check(label, actual, expected) {
  const ok = expected === undefined ? !!actual : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const SKIP = ["node_modules", "dist", "build", "out", ".git", "coverage", ".next", "tmp", ".blastradius"];
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(js|jsx|mjs|cjs|ts|mts|cts|tsx|go)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

/** The same context the extension assembles from its graph, risk cache and features. */
async function contextFor(root) {
  await initParser(path.join(__dirname, ".."));
  const graph = new CallGraph();
  for (const f of walk(root)) graph.setFile(f, indexSource(f, fs.readFileSync(f, "utf8")));
  graph.resolveEdges();
  // git resolves symlinks (/var -> /private/var on macOS); compare real paths.
  const repo = fs.realpathSync(await findRepoRoot(root));

  const functions = new Map();
  for (const n of graph.allNodes()) {
    const h = await historyForRange(repo, n.file, n.startLine, n.endLine);
    const risk = { fanIn: n.callers.size, coveragePct: null, churnCount: h.churnCount, busFactor: h.busFactor };
    const score = computeScore(risk);
    functions.set(n.id, {
      id: n.id,
      name: n.name,
      file: path.relative(repo, fs.realpathSync(n.file)),
      absFile: n.file,
      startLine: n.startLine,
      endLine: n.endLine,
      score,
      tier: tierFor(score),
      fanIn: n.callers.size,
      fanOut: n.callees.size,
      coverage: "no data",
      coverageIsProxy: false,
      churnCount: h.churnCount,
      busFactor: h.busFactor,
      gitResolved: true,
      authors: h.authors,
      commits: h.commits.map((c) => ({ hash: c.hash.slice(0, 8), name: c.name, t: c.date.getTime(), subject: c.subject })),
      callers: [...n.callers],
      callees: [...n.callees],
    });
  }
  const refs = [...functions.values()].map((f) => ({
    id: f.id, name: f.name, file: f.file, startLine: f.startLine, score: f.score, tier: f.tier,
    commitHashes: f.commits.map((c) => c.hash),
  }));
  const features = buildFeatures(await readCommits(repo), refs);
  return {
    functions,
    features,
    generatedAt: new Date("2026-09-13T12:00:00Z"),
    readLines: (abs, start, end) => {
      try {
        return fs.readFileSync(abs, "utf8").split(/\r?\n/).slice(start, end + 1);
      } catch {
        return null;
      }
    },
  };
}

function commit(repo, who, message, when) {
  const [name, email] = who;
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
}

async function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blast-radius-llm-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const ada = ["Ada Reyes", "ada@example.com"];
  const sam = ["Sam Okafor", "sam@example.com"];
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };

  write("src/db.js", "function query(table) {\n  return [table];\n}\n\nmodule.exports = { query };\n");
  commit(repo, ada, "chore: database helper", "2026-07-01T10:00:00");

  write("src/users.js", [
    "const { query } = require('./db');",
    "",
    "function getUsers() {",
    "  const rows = query('users');",
    "  return normalizeUsers(rows);",
    "}",
    "",
    "function normalizeUsers(rows) {",
    "  return rows.map((r) => ({ id: r }));",
    "}",
    "",
    "module.exports = { getUsers, normalizeUsers };",
    "",
  ].join("\n"));
  commit(repo, ada, "feature: get users from db", "2026-07-05T10:00:00");

  write("src/users.js", fs.readFileSync(path.join(repo, "src/users.js"), "utf8").replace("({ id: r })", "({ id: r, active: true })"));
  commit(repo, sam, "feature: get users from db", "2026-07-08T10:00:00");

  write("src/api.js", [
    "const { getUsers } = require('./users');",
    "",
    "function handleUsers(req) {",
    "  return { status: 200, body: getUsers() };",
    "}",
    "",
    "function handleAdmin(req) {",
    "  return handleUsers(req);",
    "}",
    "",
    "module.exports = { handleUsers, handleAdmin };",
    "",
  ].join("\n"));
  commit(repo, sam, "feature(api): users endpoint", "2026-07-10T10:00:00");

  const ctx = await contextFor(repo);
  const users = ctx.features.features.find((f) => f.name === "get users from db");
  check("fixture: feature found", !!users, true);

  const md = llm.featureMarkdown(users.key, ctx);
  fs.writeFileSync(path.join(os.tmpdir(), "blast-radius-feature-sample.md"), md);

  check("title names the feature", md.startsWith("# Feature: get users from db"), true);
  check("at-a-glance lists both people", /\| People \| Ada Reyes \(1\), Sam Okafor \(1\) \|/.test(md) || /Sam Okafor \(1\), Ada Reyes \(1\)/.test(md), true);
  check("names who to ask first", /\| Ask first \| (Ada Reyes|Sam Okafor) </.test(md), true);
  check("commits appear oldest first", md.indexOf("2026-07-05") < md.indexOf("2026-07-08"), true);
  check("lists the feature's file", md.includes("`src/users.js`"), true);
  check("function table includes getUsers", /\| `getUsers` \| src\/users\.js:3-6 \|/.test(md), true);
  check("function table includes normalizeUsers", md.includes("`normalizeUsers`"), true);
  check("internal call is shown", md.includes("`getUsers` -> `normalizeUsers`"), true);
  check("caller outside the feature is shown", /`getUsers` is called by `handleUsers` \(src\/api\.js:3-5\)/.test(md), true);
  check("dependency outside the feature is shown", /`query` \(src\/db\.js:1-3\) - used by `getUsers`/.test(md), true);
  check("real source code is embedded", md.includes("```javascript") && md.includes("const rows = query('users');"), true);
  check("source reflects the latest edit", md.includes("active: true"), true);
  check("history table has both commits", (md.match(/\| feature \| get users from db \|/g) || []).length, 2);
  check("no unfilled template text", /undefined|NaN|\[object Object\]/.test(md), false);

  // function document keeps the PR's sections and adds code + features
  const getUsersId = [...ctx.functions.values()].find((f) => f.name === "getUsers").id;
  const fmd = llm.functionMarkdown(getUsersId, ctx);
  for (const heading of ["## Summary", "## Callers", "## Calls", "## Risk notes", "## Score formula"]) {
    check(`function doc keeps "${heading}" from the original`, fmd.includes(heading), true);
  }
  check("function doc embeds its source", fmd.includes("## Source") && fmd.includes("return normalizeUsers(rows);"), true);
  check("function doc names its feature", fmd.includes('belongs to the feature "get users from db"'), true);
  check("function doc counts indirect reach", /can reach 2 functions/.test(fmd), true);
  check("function doc lists its callers with locations", fmd.includes("`handleUsers` (src/api.js:3-5)"), true);

  // caps keep huge functions from swamping a prompt
  const capped = llm.featureMarkdown(users.key, { ...ctx, maxLinesPerFunction: 2 });
  check("long functions are truncated with a pointer", /_Showing 2 of 4 lines - the rest is at `src\/users\.js:3-6`\._/.test(capped), true);
  const starved = llm.featureMarkdown(users.key, { ...ctx, maxSourceLines: 0 });
  check("an exhausted budget omits source but says where", starved.includes("_Source omitted"), true);
  const unreadable = llm.featureMarkdown(users.key, { ...ctx, readLines: () => null });
  check("unreadable files are reported, not crashed on", unreadable.includes("_Source unavailable"), true);

  // index + file names
  const names = llm.assignFeatureFileNames([{ key: "scope:users", name: "users" }, { key: "title:users", name: "Users!" }]);
  check("colliding feature names get distinct files", [...names.values()], ["users.md", "users-2.md"]);
  const index = llm.featuresIndexMarkdown(ctx.features.features, ctx);
  check("index links every feature file", ctx.features.features.every((f) => index.includes("](features/")), true);
  check("unknown feature is handled", llm.featureMarkdown("nope", ctx).startsWith("# Unknown feature"), true);

  console.log(`\nsample written to ${path.join(os.tmpdir(), "blast-radius-feature-sample.md")}`);
  fs.rmSync(repo, { recursive: true, force: true });
}

async function exportRepo(root, outDir) {
  const ctx = await contextFor(root);
  const features = ctx.features.features;
  const names = llm.assignFeatureFileNames(features);
  fs.mkdirSync(path.join(outDir, "features"), { recursive: true });
  for (const f of features) {
    fs.writeFileSync(path.join(outDir, "features", names.get(f.key)), llm.featureMarkdown(f.key, ctx));
  }
  fs.writeFileSync(path.join(outDir, "FEATURES.md"), llm.featuresIndexMarkdown(features, ctx, names));
  console.log(`${features.length} feature documents written to ${outDir}`);
}

(async () => {
  if (process.argv[2]) {
    await exportRepo(path.resolve(process.argv[2]), path.resolve(process.argv[3] || "llm-out"));
    return;
  }
  await fixture();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall llm checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
