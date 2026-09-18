/**
 * Dev helper: verify the features view end to end.
 *
 *   npm run compile && node scripts/check-features.js            # fixture repo
 *   node scripts/check-features.js ~/some-repo                   # report on a real repo
 *
 * With no argument it builds a throwaway git repository in the OS temp dir with
 * commits written in the convention, indexes it, reads per-function history
 * exactly like the extension does, and asserts on the resulting features.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { indexSource, initParser } = require("../out/indexer");
const { CallGraph } = require("../out/graph");
const { findRepoRoot, historyForRange } = require("../out/git");
const { parseCommitMessage, readCommits, buildFeatures } = require("../out/features");

let failures = 0;
function check(label, actual, expected) {
  const ok = expected === undefined ? !!actual : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`,
  );
}

const SKIP = ["node_modules", "dist", "build", "out", ".git", "coverage", ".next", "tmp"];
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(js|jsx|mjs|cjs|ts|mts|cts|tsx|go)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

async function featuresFor(root) {
  await initParser(path.join(__dirname, ".."));
  const graph = new CallGraph();
  for (const f of walk(root)) graph.setFile(f, indexSource(f, fs.readFileSync(f, "utf8")));
  graph.resolveEdges();
  const repo = await findRepoRoot(root);
  const refs = [];
  for (const n of graph.allNodes()) {
    const h = await historyForRange(repo, n.file, n.startLine, n.endLine);
    refs.push({
      id: n.id,
      name: n.name,
      file: path.relative(repo, n.file),
      startLine: n.startLine,
      score: n.callers.size,
      tier: "low",
      commitHashes: h.commits.map((c) => c.hash.slice(0, 8)),
    });
  }
  return buildFeatures(await readCommits(repo), refs);
}

function commit(repo, author, message, when) {
  const [name, email] = author;
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    },
  });
}

async function fixture() {
  // ---- message parsing ----
  const cases = [
    ["feature: get users from db", { type: "feature", scope: null, title: "get users from db", breaking: false }],
    ["feat: get users from db", { type: "feature", scope: null, title: "get users from db", breaking: false }],
    ["Bug Fix: empty page crash.", { type: "bug fix", scope: null, title: "empty page crash", breaking: false }],
    ["bugfix: x", { type: "bug fix", scope: null, title: "x", breaking: false }],
    ["fix(billing): rounding", { type: "bug fix", scope: "billing", title: "rounding", breaking: false }],
    ["refactor(auth)!: drop sessions", { type: "refactor", scope: "auth", title: "drop sessions", breaking: true }],
    ["perf: faster search", { type: "performance", scope: null, title: "faster search", breaking: false }],
    ["added seeding routes", null],
    ["Merge pull request #12: stuff", null],
    ["note: not a known type", null],
    ["feature:", null],
  ];
  for (const [input, expected] of cases) {
    check(`parse ${JSON.stringify(input)}`, parseCommitMessage(input), expected);
  }

  // ---- a real repo with tagged history ----
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blast-radius-features-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const ada = ["Ada Reyes", "ada@example.com"];
  const sam = ["Sam Okafor", "sam@example.com"];
  const priya = ["Priya Nair", "priya@example.com"];

  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };

  write("src/users.js", "function getUsers(db) {\n  return db.query('users');\n}\n\nfunction listUsers(db) {\n  return getUsers(db);\n}\n\nmodule.exports = { getUsers, listUsers };\n");
  commit(repo, ada, "feature: get users from db", "2026-08-01T10:00:00");

  write("src/users.js", "function getUsers(db) {\n  const rows = db.query('users');\n  return rows || [];\n}\n\nfunction listUsers(db) {\n  return getUsers(db);\n}\n\nmodule.exports = { getUsers, listUsers };\n");
  commit(repo, sam, "feature: Get users from DB", "2026-08-03T10:00:00");

  write("src/users.js", "function getUsers(db) {\n  const rows = db.query('users');\n  return rows || [];\n}\n\nfunction listUsers(db) {\n  const users = getUsers(db);\n  return users.length ? users : [];\n}\n\nmodule.exports = { getUsers, listUsers };\n");
  commit(repo, priya, "bug fix: users list crashes on empty page", "2026-08-05T10:00:00");

  write("src/billing.js", "function computeTotal(items) {\n  return items.reduce((a, b) => a + b.price, 0);\n}\n\nmodule.exports = { computeTotal };\n");
  commit(repo, ada, "refactor(billing): split invoice math", "2026-08-07T10:00:00");

  write("src/billing.js", "function computeTotal(items) {\n  const sum = items.reduce((a, b) => a + b.price, 0);\n  return Math.round(sum * 100) / 100;\n}\n\nmodule.exports = { computeTotal };\n");
  commit(repo, sam, "fix(billing): rounding error", "2026-08-09T10:00:00");

  write("README.md", "# fixture\n");
  commit(repo, priya, "added readme", "2026-08-10T10:00:00");

  const result = await featuresFor(repo);
  const byName = new Map(result.features.map((f) => [f.name.toLowerCase(), f]));

  check("counts every commit", result.totalCommits, 6);
  check("counts tagged commits", result.taggedCommits, 5);
  check("lists untagged commits", result.untagged.map((u) => u.subject), ["added readme"]);
  check("three features", result.features.length, 3);

  const users = byName.get("get users from db");
  check("same title, different case, merges", !!users && users.commits.length, 2);
  check("feature authors", users && users.authors.map((a) => a.name).sort(), ["Ada Reyes", "Sam Okafor"]);
  check("feature files", users && users.files.map((f) => f.path), ["src/users.js"]);
  check("feature functions come from line history",
    users && users.functions.map((f) => f.name).includes("getUsers"), true);
  check("primary type", users && users.primaryType, "feature");

  const crash = byName.get("users list crashes on empty page");
  check("bug fix is its own feature", crash && crash.primaryType, "bug fix");
  check("bug fix touched listUsers", crash && crash.functions.map((f) => f.name).includes("listUsers"), true);
  check("bug fix did not claim getUsers", crash && crash.functions.map((f) => f.name).includes("getUsers"), false);

  const billing = byName.get("billing");
  check("scope groups different titles", billing && billing.commits.length, 2);
  check("scoped feature mixes types", billing && Object.entries(billing.typeCounts).sort(), [["bug fix", 1], ["refactor", 1]]);
  check("scoped feature functions", billing && billing.functions.map((f) => f.name), ["computeTotal"]);

  const adaPerson = result.people.find((p) => p.name === "Ada Reyes");
  check("who worked on what", adaPerson && adaPerson.features.map((f) => f.name).sort(), ["billing", "get users from db"]);
  check("newest feature first", result.features[0].name, "billing");

  fs.rmSync(repo, { recursive: true, force: true });
}

async function report(root) {
  const result = await featuresFor(root);
  console.log(`${result.taggedCommits} of ${result.totalCommits} commits tagged, ${result.features.length} features`);
  console.log(`functions with history: ${result.functionsWithHistory}/${result.functionsTotal}\n`);
  for (const f of result.features.slice(0, 20)) {
    console.log(
      `[${f.primaryType}] ${f.name}  - ${f.commits.length} commits, ${f.authors.map((a) => a.name).join(", ")}, ` +
        `${f.files.length} files, ${f.functions.length} functions`,
    );
  }
  if (!result.features.length) {
    console.log("No tagged commits yet. First untagged subjects:");
    result.untagged.slice(0, 5).forEach((u) => console.log("  -", u.subject));
  }
}

(async () => {
  if (process.argv[2]) {
    await report(path.resolve(process.argv[2]));
    return;
  }
  await fixture();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall feature checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
