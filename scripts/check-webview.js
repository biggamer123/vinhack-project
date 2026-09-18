/**
 * Dev helper: load media/graph.html in a headless DOM, feed it the real demo
 * graph, and drive the interactions - so webview regressions surface without
 * launching the Extension Development Host.
 *
 *   npm run compile && node scripts/check-webview.js demo
 */
const path = require("path");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { indexSource, initParser } = require("../out/indexer");
const { CallGraph } = require("../out/graph");
const { parseLcov, coverageForRange } = require("../out/lcov");
const { computeScore, tierFor } = require("../out/score");
const { findRepoRoot, historyForRange } = require("../out/git");
const { buildStandaloneHtml, removeCdnScripts } = require("../out/standalone");

const root = path.resolve(process.argv[2] || "demo");
const SKIP = ["node_modules", "dist", "build", "out", ".git", "coverage"];
const posted = [];
let failures = 0;

function check(label, actual, expected) {
  const ok = expected === undefined ? !!actual : actual === expected;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`,
  );
}

/**
 * jsdom reports zero-size elements and implements neither the SVG width/height
 * animated values nor getScreenCTM, all of which d3 reads. Real browsers have
 * them; stub them so the layout and zoom paths actually run.
 */
function applyDomShims(w) {
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", {
    get: () => 1000,
    configurable: true,
  });
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", {
    get: () => 700,
    configurable: true,
  });
  for (const [prop, value] of [
    ["width", 1000],
    ["height", 700],
  ]) {
    Object.defineProperty(w.SVGSVGElement.prototype, prop, {
      get: () => ({ baseVal: { value } }),
      configurable: true,
    });
  }
  w.SVGSVGElement.prototype.createSVGPoint = function () {
    return { x: 0, y: 0, matrixTransform: () => ({ x: 0, y: 0 }) };
  };
  w.SVGGraphicsElement.prototype.getScreenCTM = function () {
    return {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
      inverse: () => this.getScreenCTM(),
    };
  };
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(js|jsx|mjs|cjs|ts|mts|cts|tsx)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

async function buildPayload() {
  await initParser(path.join(__dirname, ".."));
  const graph = new CallGraph();
  for (const f of walk(root))
    graph.setFile(f, indexSource(f, fs.readFileSync(f, "utf8")));
  graph.resolveEdges();

  const lcovPath = path.join(root, "coverage/lcov.info");
  const lcov = fs.existsSync(lcovPath)
    ? parseLcov(root, fs.readFileSync(lcovPath, "utf8"))
    : new Map();
  const repo = await findRepoRoot(root);

  const nodes = [];
  const edges = [];
  for (const n of graph.allNodes()) {
    const coveragePct = lcov.size
      ? coverageForRange(lcov, n.file, n.startLine, n.endLine)
      : null;
    const h = repo
      ? await historyForRange(repo, n.file, n.startLine, n.endLine)
      : null;
    const risk = {
      fanIn: n.callers.size,
      coveragePct,
      coverageIsProxy: lcov.size === 0,
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
  return {
    type: "graph",
    nodes,
    edges,
    summary: `${nodes.length} functions`,
    focus: nodes[0].id,
  };
}

(async () => {
  const payload = await buildPayload();

  // Load the real page, minus the CSP meta and the CDN <script> (d3 comes from node_modules).
  let html = fs
    .readFileSync(path.join(__dirname, "..", "media", "graph.html"), "utf8")
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace(/<script [^>]*src="https:\/\/cdnjs[^"]*"[^>]*><\/script>/, "")
    .replace(/\{\{nonce\}\}/g, "test")
    .replace(/\{\{cspSource\}\}/g, "vscode-resource:");

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // d3 resolves `document` from the global scope at require time.
  global.window = window;
  global.document = window.document;
  global.navigator = window.navigator;
  // d3-zoom reads these off the global scope; in a browser they are always there.
  global.SVGElement = window.SVGElement;
  global.Element = window.Element;
  global.Node = window.Node;
  applyDomShims(window);
  window.d3 = require("d3");
  window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });

  const script = /<script nonce="test">([\s\S]*?)<\/script>/.exec(html)[1];
  window.eval(script);

  check(
    "page signals ready to the extension host",
    posted[0] && posted[0].type,
    "ready",
  );

  window.dispatchEvent(new window.MessageEvent("message", { data: payload }));
  await new Promise((r) => setTimeout(r, 400));

  const doc = window.document;
  check(
    "all nodes rendered",
    doc.querySelectorAll("g.node").length,
    payload.nodes.length,
  );
  check(
    "all edges rendered",
    doc.querySelectorAll("line.link").length,
    payload.edges.length,
  );
  check(
    "subtitle shows the summary",
    doc.getElementById("subtitle").textContent.includes("FUNCTIONS"),
  );
  check(
    "HUD reports tier counts",
    doc.getElementById("hud").innerHTML.includes("GRASS"),
  );

  // The focus id from a CodeLens click should already have opened that dex entry.
  const entry = doc.getElementById("entry");
  check(
    "focused function opened its dex entry",
    entry.querySelector(".mon").textContent,
    payload.nodes[0].name,
  );
  check(
    "entry shows a tier badge",
    entry.querySelector(".badge").textContent.length > 0,
  );
  check("entry shows stat bars", entry.querySelectorAll(".statrow").length, 5);
  check(
    "entry shows the score arithmetic",
    entry
      .querySelector(".formula")
      .textContent.includes("= " + payload.nodes[0].score),
  );
  check(
    "callers/callees panel rendered",
    doc.getElementById("relations").innerHTML.includes("CALLED BY"),
  );

  // Clicking OPEN IN EDITOR must message the extension host with the node id.
  entry
    .querySelector("#open")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const reveal = posted.find((m) => m.type === "reveal");
  check(
    "OPEN IN EDITOR posts a reveal message",
    reveal && reveal.id,
    payload.nodes[0].id,
  );

  // Clicking a different node switches the entry.
  const circles = doc.querySelectorAll("g.node circle");
  circles[circles.length - 1].dispatchEvent(
    new window.MouseEvent("click", { bubbles: true }),
  );
  check(
    "clicking a node switches the dex entry",
    entry.querySelector(".mon").textContent !== payload.nodes[0].name,
  );

  // Tier filter hides nodes.
  const before = [...doc.querySelectorAll("g.node")].filter(
    (n) => n.style.display !== "none",
  ).length;
  doc
    .querySelector('.tierchip[data-tier="low"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const after = [...doc.querySelectorAll("g.node")].filter(
    (n) => n.style.display !== "none",
  ).length;
  check("tier filter hides the low-risk nodes", after < before);

  // Search filters by name.
  const search = doc.getElementById("search");
  search.value = "trace";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  check(
    "search narrows the view",
    [...doc.querySelectorAll("g.node")].filter(
      (n) => n.style.display !== "none",
    ).length < after,
  );

  // --- standalone (browser snapshot) mode: host-dependent buttons must disappear ---
  window.dispatchEvent(
    new window.MessageEvent("message", {
      data: Object.assign({}, payload, {
        standalone: true,
        focus: payload.nodes[0].id,
      }),
    }),
  );
  await new Promise((r) => setTimeout(r, 400));
  check(
    "standalone hides OPEN IN BROWSER",
    doc.getElementById("browser").style.display,
    "none",
  );
  check("standalone hides OPEN IN EDITOR", doc.getElementById("open"), null);
  check(
    "standalone still renders the graph",
    doc.querySelectorAll("g.node").length,
    payload.nodes.length,
  );

  // centerOn() runs a zoom transition on focus - make sure it actually transformed.
  await new Promise((r) => setTimeout(r, 900));
  check(
    "focus zoomed the canvas",
    (doc.querySelector("svg > g").getAttribute("transform") || "").includes(
      "translate",
    ),
  );

  // --- the browser snapshot: boot the REAL generated file, with no vscode host ---
  // (regression: the stub used to be injected after the page script, so
  // acquireVsCodeApi() threw and the page hung on "booting dex…")
  const template = fs.readFileSync(
    path.join(__dirname, "..", "media", "graph.html"),
    "utf8",
  );
  const standaloneHtml = removeCdnScripts(
    buildStandaloneHtml(template, payload, "test stamp"),
  );
  // Anchor on text a formatter cannot rewrite: the page's own typeof guard.
  check(
    "bootstrap is injected before the page script",
    standaloneHtml.indexOf("__blastRadiusData") <
      standaloneHtml.indexOf("acquireVsCodeApi ==="),
  );

  const dom2 = new JSDOM(standaloneHtml, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w2 = dom2.window;
  w2.d3 = require("d3");
  applyDomShims(w2);
  // d3 resolves `document` from the global scope at call time - point it at the
  // second DOM, or its selections land back in the first one.
  global.window = w2;
  global.document = w2.document;
  global.SVGElement = w2.SVGElement;
  // NOTE: no acquireVsCodeApi defined here on purpose - the page must supply its own.
  for (const block of standaloneHtml.match(
    /<script nonce="standalone">([\s\S]*?)<\/script>/g,
  ) || []) {
    w2.eval(block.replace(/<\/?script[^>]*>/g, ""));
  }
  w2.dispatchEvent(new w2.Event("load"));
  await new Promise((r) => setTimeout(r, 500));

  const d2 = w2.document;
  check(
    "snapshot page renders its nodes",
    d2.querySelectorAll("g.node").length,
    payload.nodes.length,
  );
  check(
    "snapshot page leaves booting state",
    d2.getElementById("subtitle").textContent.includes("SNAPSHOT"),
  );
  check(
    "snapshot HUD leaves LOADING state",
    !d2.getElementById("hud").innerHTML.includes("LOADING"),
  );
  check(
    "snapshot hides OPEN IN BROWSER",
    d2.getElementById("browser").style.display,
    "none",
  );

  // --- worst case: no host API and no injected data at all. The page must still
  // boot and explain itself rather than render a blank canvas. ---
  const strippedHtml = standaloneHtml.replace(
    /<script nonce="standalone">[\s\S]*?<\/script>/,
    "",
  );
  const dom3 = new JSDOM(strippedHtml, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w3 = dom3.window;
  w3.d3 = require("d3");
  applyDomShims(w3);
  global.window = w3;
  global.document = w3.document;
  global.SVGElement = w3.SVGElement;
  let threw = null;
  try {
    for (const block of strippedHtml.match(
      /<script nonce="standalone">([\s\S]*?)<\/script>/g,
    ) || []) {
      w3.eval(block.replace(/<\/?script[^>]*>/g, ""));
    }
    const body =
      /<script nonce="standalone">([\s\S]*?)<\/script>\s*<\/body>/.exec(
        standaloneHtml,
      );
    w3.eval(
      /<script nonce="standalone">([\s\S]*)<\/script>/s.exec(
        standaloneHtml.slice(
          standaloneHtml.lastIndexOf('<script nonce="standalone">'),
        ),
      )[1],
    );
  } catch (e) {
    threw = e;
  }
  check("page survives with no host API at all", threw, null);
  w3.__watchdog = true;
  await new Promise((r) => setTimeout(r, 4300));
  check(
    "watchdog explains an empty canvas",
    w3.document.getElementById("hud").innerHTML.includes("NO GRAPH DATA"),
  );

  // --- a formatter rewrapping the template must not break the browser export ---
  // Regression: the injector used to anchor on `<script ` with a literal space.
  // Prettier split that tag across lines in media/graph.html, so OPEN IN BROWSER
  // threw "could not find the d3 script tag" for anyone who pulled the repo.
  const reformatted = template
    .replace(/<script\s+nonce/g, "<script\n      nonce")
    .replace(/\ssrc="https/g, '\n      src="https')
    .replace(/"><\/script>/g, '"\n    ></script>')
    .replace(
      /<meta http-equiv="Content-Security-Policy"\s+content=/,
      '<meta\n      http-equiv="Content-Security-Policy"\n      content=',
    );
  let reformatOk = false;
  let reformatErr = "";
  try {
    const out = buildStandaloneHtml(reformatted, payload, "reformatted");
    reformatOk =
      out.indexOf("__blastRadiusData") < out.indexOf("acquireVsCodeApi ===") &&
      !out.includes("Content-Security-Policy") &&
      !out.includes("{{");
  } catch (e) {
    reformatErr = " [" + e.message + "]";
  }
  check("builds from a reformatted template" + reformatErr, reformatOk, true);

  // ---------------- tabs, rail list, tooltip, lineage modal, git view ----------------
  const fire = (el, type, init) =>
    el.dispatchEvent(new w2.window.MouseEvent(type, { bubbles: true, ...(init || {}) }));

  // back to the first DOM for these checks
  global.window = window;
  global.document = window.document;
  global.SVGElement = window.SVGElement;
  const click = (el, init) =>
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, ...(init || {}) }));

  // orphans must be parked in the grid, not flung across the canvas
  const orphanIds = new Set(
    payload.nodes.filter((n) => n.fanIn === 0 && n.fanOut === 0).map((n) => n.id),
  );
  const orphanLabel = doc.querySelector("text.orphan-label");
  check("orphans get a labelled parking grid", !!orphanLabel || orphanIds.size === 0, true);

  // tab switching
  click(doc.querySelector('.tab[data-tab="index"]'));
  check("INDEX tab activates", doc.getElementById("view-index").classList.contains("on"), true);
  check("INDEX table fills", doc.querySelectorAll("#indexTable tbody tr").length, payload.nodes.length);
  const indexSearch = doc.getElementById("indexSearch");
  indexSearch.value = "trace";
  indexSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
  const narrowed = doc.querySelectorAll("#indexTable tbody tr").length;
  check("INDEX search narrows", narrowed > 0 && narrowed < payload.nodes.length, true);
  indexSearch.value = "";
  indexSearch.dispatchEvent(new window.Event("input", { bubbles: true }));

  click(doc.querySelector('.tab[data-tab="git"]'));
  check("GIT tab activates", doc.getElementById("view-git").classList.contains("on"), true);
  check("GIT author cards render", doc.querySelectorAll(".authorcard").length > 0, true);
  check("GIT rows render", doc.querySelectorAll("#gitTable tbody tr").length > 0, true);
  check("GIT shows a lead changer", doc.querySelector("#gitTable tbody td.lead").textContent.trim().length > 1, true);
  check("GIT contribution bars render", doc.querySelectorAll("#gitTable .contrib span").length > 0, true);

  click(doc.querySelector('.tab[data-tab="graph"]'));
  check("GRAPH tab returns", doc.getElementById("view-graph").classList.contains("on"), true);

  // rail list: search + select drives the graph selection
  const railSearch = doc.getElementById("railSearch");
  railSearch.value = "trace";
  railSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
  const railRows = doc.querySelectorAll("#railList .row");
  check("rail list filters by search", railRows.length > 0 && railRows.length < payload.nodes.length, true);
  click(railRows[0]);
  check("rail selection selects in the graph", doc.querySelectorAll("g.node.sel").length, 1);

  // hover tooltip on a graph node
  const someCircle = doc.querySelector("g.node circle");
  someCircle.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true, clientX: 200, clientY: 200 }));
  const tip = doc.getElementById("tip");
  check("hover tooltip appears", tip.classList.contains("on"), true);
  check("tooltip summarises risk", tip.innerHTML.includes("CALLERS") && tip.innerHTML.includes("RISK"), true);
  check("tooltip offers a git jump", !!tip.querySelector('[data-act="git"]'), true);

  // tooltip -> git tab, focused on that function
  click(tip.querySelector('[data-act="git"]'));
  check("tooltip git button opens the GIT tab", doc.getElementById("view-git").classList.contains("on"), true);
  check("GIT tab focuses that function", doc.querySelector(".focusbar").textContent.includes("FOCUSED"), true);
  click(doc.querySelector('.tab[data-tab="graph"]'));

  // lineage modal
  const lineageBtn = doc.getElementById("lineageBtn");
  check("dex entry offers VIEW LINEAGE", !!lineageBtn, true);
  click(lineageBtn);
  check("lineage modal opens", doc.getElementById("lineage").classList.contains("on"), true);
  check("lineage renders a chain", doc.querySelectorAll("#lineageBody .chip").length > 0, true);
  check("lineage marks the focused function", doc.querySelectorAll("#lineageBody .chip.self").length, 1);
  check("lineage has window chrome", doc.querySelectorAll(".titlebar .light").length, 3);
  click(doc.getElementById("lineageClose"));
  check("lineage modal closes", doc.getElementById("lineage").classList.contains("on"), false);

  // sort direction must match the header arrow: descending puts the biggest first
  click(doc.querySelector('.tab[data-tab="git"]'));
  const churnCol = [...doc.querySelectorAll("#gitTable tbody tr")].map((tr) =>
    Number(tr.children[0].textContent),
  );
  check("GIT sorts churn descending", churnCol[0] >= churnCol[churnCol.length - 1] && churnCol[0] > 0, true);
  click(doc.querySelector('.tab[data-tab="index"]'));
  const riskCol = [...doc.querySelectorAll("#indexTable tbody tr")].map((tr) =>
    Number(tr.children[0].textContent),
  );
  check("INDEX sorts risk descending", riskCol[0] >= riskCol[riskCol.length - 1] && riskCol[0] > 0, true);
  click(doc.querySelector('.tab[data-tab="graph"]'));

  // ---------------- database schema tab (src/schema.ts feeds this) ----------------
  const schemaTab = doc.querySelector('.tab[data-tab="schema"]');
  check("SCHEMA tab exists", !!schemaTab, true);
  click(schemaTab);
  check("SCHEMA tab activates", doc.getElementById("view-schema").classList.contains("on"), true);
  check("SCHEMA tab is never blank", doc.getElementById("schemaBody").textContent.trim().length > 0, true);
  // This DOM was switched into standalone mode by an earlier check, where schema
  // detection cannot run - it must say so rather than sit empty.
  check("SCHEMA tab explains itself in a browser snapshot",
    doc.getElementById("schemaBody").textContent.includes("VS Code"), true);

  // In a real webview, opening the tab asks the extension host to run detection.
  const posted4 = [];
  const dom4 = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const w4 = dom4.window;
  w4.d3 = require("d3");
  applyDomShims(w4);
  w4.acquireVsCodeApi = () => ({ postMessage: (m) => posted4.push(m) });
  global.window = w4;
  global.document = w4.document;
  global.SVGElement = w4.SVGElement;
  w4.eval(script);
  w4.dispatchEvent(new w4.MessageEvent("message", { data: payload }));
  await new Promise((r) => setTimeout(r, 300));
  w4.document.querySelector('.tab[data-tab="schema"]')
    .dispatchEvent(new w4.MouseEvent("click", { bubbles: true }));
  check("SCHEMA tab requests detection from the host",
    posted4.some((m) => m.type === "schema"), true);
  global.window = window;
  global.document = window.document;
  global.SVGElement = window.SVGElement;
  // and the host's reply (even an empty-workspace one) is rendered
  window.dispatchEvent(new window.MessageEvent("message", {
    data: Object.assign({}, payload, {
      schemaHtml: "<h1>Database Schemas</h1><p>No SQL or NoSQL schema declarations were detected.</p>",
      viewMode: "schema",
    }),
  }));
  await new Promise((r) => setTimeout(r, 300));
  check("SCHEMA tab renders the host's reply",
    doc.getElementById("schemaBody").textContent.includes("No SQL or NoSQL"), true);
  check("host viewMode:schema focuses the tab",
    doc.getElementById("view-schema").classList.contains("on"), true);
  click(doc.querySelector('.tab[data-tab="graph"]'));

  console.log(
    failures ? `\n${failures} FAILURE(S)` : "\nall webview checks passed",
  );
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
