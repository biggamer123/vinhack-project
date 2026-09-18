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
const { PROTOCOL_VERSION } = require("../out/protocol");

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
    else if (/\.(js|jsx|mjs|cjs|ts|mts|cts|tsx|go)$/.test(e.name)) acc.push(full);
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

  // ---------------- orphan shelf must clear the graph ----------------
  const coords = (sel) =>
    [...doc.querySelectorAll(sel)].map((g) => {
      const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute("transform") || "");
      return m ? { x: +m[1], y: +m[2], id: g.__data__ && g.__data__.id } : null;
    }).filter(Boolean);
  const placed = coords("g.node");
  const orphanSet = new Set(
    payload.nodes.filter((n) => n.fanIn === 0 && n.fanOut === 0).map((n) => n.id),
  );
  if (orphanSet.size && placed.length) {
    const graphNodes = placed.filter((p) => !orphanSet.has(p.id));
    const shelfNodes = placed.filter((p) => orphanSet.has(p.id));
    const graphBottom = Math.max(...graphNodes.map((p) => p.y));
    const shelfTop = Math.min(...shelfNodes.map((p) => p.y));
    check("orphan shelf sits below the settled graph", shelfTop > graphBottom, true);
    check("orphan shelf is captioned", !!doc.querySelector("text.orphan-label"), true);
  }

  // ---------------- stale extension host is called out ----------------
  const posted5 = [];
  const dom5 = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const w5 = dom5.window;
  w5.d3 = require("d3");
  applyDomShims(w5);
  w5.acquireVsCodeApi = () => ({ postMessage: (m) => posted5.push(m) });
  global.window = w5;
  global.document = w5.document;
  global.SVGElement = w5.SVGElement;
  w5.eval(script);
  // a payload with no protocol stamp is what an old host sends
  w5.dispatchEvent(new w5.MessageEvent("message", { data: payload }));
  await new Promise((r) => setTimeout(r, 300));
  check("old host payload raises the stale banner",
    w5.document.getElementById("staleHost").style.display, "block");
  // a current payload must not raise it
  const dom6 = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const w6 = dom6.window;
  w6.d3 = require("d3");
  applyDomShims(w6);
  w6.acquireVsCodeApi = () => ({ postMessage: () => {} });
  global.window = w6;
  global.document = w6.document;
  global.SVGElement = w6.SVGElement;
  w6.eval(script);
  w6.dispatchEvent(new w6.MessageEvent("message", {
    data: Object.assign({}, payload, { protocol: PROTOCOL_VERSION }),
  }));
  await new Promise((r) => setTimeout(r, 300));
  check("current host payload leaves it hidden",
    w6.document.getElementById("staleHost").style.display !== "block", true);
  global.window = window;
  global.document = window.document;
  global.SVGElement = window.SVGElement;

  const sampleSchema = {
    tables: [
      { name: "users", kind: "sql", source: "db/0001_init.sql", fields: [
        { name: "id", type: "uuid", nullable: false, primaryKey: true },
        { name: "email", type: "text", nullable: false, primaryKey: false }] },
      { name: "machines", kind: "sql", source: "db/0002.sql", fields: [
        { name: "id", type: "uuid", nullable: false, primaryKey: true },
        { name: "user_id", type: "uuid", nullable: true, primaryKey: false }] },
    ],
    relations: [{ from: "machines", to: "users", label: "user_id" }],
    filesScanned: 163,
    usedFallback: false,
    root: "/repo",
  };

  // ---------------- database viewer ----------------
  const schemaTab = doc.querySelector('.tab[data-tab="schema"]');
  check("SCHEMA tab exists", !!schemaTab, true);
  click(schemaTab);
  check("SCHEMA tab activates", doc.getElementById("view-schema").classList.contains("on"), true);
  check("SCHEMA tab is never blank", doc.getElementById("dbhud").textContent.trim().length > 0, true);

  window.dispatchEvent(new window.MessageEvent("message", {
    data: Object.assign({}, payload, { protocol: PROTOCOL_VERSION, schema: sampleSchema }),
  }));
  await new Promise((r) => setTimeout(r, 250));
  check("tables render as cards", doc.querySelectorAll("#dbcanvas .tablecard").length, 2);
  check("fields are listed", doc.querySelectorAll("#dbcanvas .fieldrow").length >= 4, true);
  check("primary keys are marked", doc.querySelectorAll("#dbcanvas .fieldrow.pk").length, 2);
  check("relations are drawn", doc.querySelectorAll("#dblinks path[marker-end]").length, 1);
  check("viewer reports the scan", doc.getElementById("dbhud").textContent.includes("2 TABLES"), true);

  // dragging a table must move it AND keep the link attached
  const card = doc.querySelector('#dbcanvas .tablecard[data-name="machines"]');
  const linkBefore = doc.querySelector("#dblinks path[marker-end]").getAttribute("d");
  const beforeLeft = card.style.left;
  card.querySelector(".th").dispatchEvent(
    new window.MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 100 }));
  window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 260 }));
  window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  check("dragging moves the table", card.style.left !== beforeLeft, true);
  const linkAfter = doc.querySelector("#dblinks path[marker-end]").getAttribute("d");
  check("relation follows the dragged table", linkAfter !== linkBefore, true);

  // empty states must say what actually happened
  const dbStates = [
    [{ tables: [], relations: [], filesScanned: 1400, usedFallback: false, root: "/repo" }, "1400"],
    [{ tables: [], relations: [], filesScanned: 0, usedFallback: true, root: "/repo" }, "NO FILES SCANNED"],
    [{ tables: [], relations: [], filesScanned: 12, usedFallback: false, root: "/repo", error: "EACCES" }, "EACCES"],
  ];
  for (const [schema, expected] of dbStates) {
    window.dispatchEvent(new window.MessageEvent("message", {
      data: Object.assign({}, payload, { protocol: PROTOCOL_VERSION, schema }),
    }));
    await new Promise((r) => setTimeout(r, 120));
    check(`empty viewer explains: ${expected}`,
      doc.getElementById("dbhud").textContent.includes(expected), true);
  }
  check("scan with files names what it looked for",
    doc.getElementById("dbhud").textContent.length > 10, true);

  // SPREAD OUT: even cells, no overlaps, links still attached
  window.dispatchEvent(new window.MessageEvent("message", {
    data: Object.assign({}, payload, { protocol: PROTOCOL_VERSION, schema: sampleSchema }),
  }));
  await new Promise((r) => setTimeout(r, 200));
  click(doc.getElementById("schemaSpread"));
  await new Promise((r) => setTimeout(r, 150));
  const spread = [...doc.querySelectorAll("#dbcanvas .tablecard")].map((c) => ({
    name: c.dataset.name,
    x: parseFloat(c.style.left),
    y: parseFloat(c.style.top),
    w: 230,
    h: c.getElementsByClassName("fieldrow").length * 17 + 56,
  }));
  check("spread places every table", spread.length, sampleSchema.tables.length);
  let collide = 0;
  for (let i = 0; i < spread.length; i++) {
    for (let j = i + 1; j < spread.length; j++) {
      const a = spread[i], b = spread[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) collide++;
    }
  }
  check("spread leaves no overlapping tables", collide, 0);
  // gaps between adjacent columns must be identical
  const xs = [...new Set(spread.map((s) => Math.round(s.x)))].sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  check("spread uses even column spacing", new Set(gaps).size <= 1, true);
  check("relations survive the spread",
    doc.querySelectorAll("#dblinks path[marker-end]").length, sampleSchema.relations.length);
  check("spread reports what it did",
    doc.getElementById("dbhud").textContent.includes("SPREAD"), true);

  // ---------------- features view ----------------
  const firstFn = payload.nodes[0];
  const secondFn = payload.nodes[1];
  const sampleFeatures = {
    features: [
      {
        key: "title:get users from db", name: "get users from db", scope: null, primaryType: "feature",
        typeCounts: { feature: 2 },
        commits: [
          { hash: "aaaa1111", type: "feature", title: "get users from db", author: "Ada", email: "ada@x", t: Date.now(), files: ["src/users.js"], breaking: false },
          { hash: "bbbb2222", type: "feature", title: "get users from db", author: "Sam", email: "sam@x", t: Date.now() - 1e8, files: ["src/users.js"], breaking: false },
        ],
        authors: [{ name: "Ada", email: "ada@x", commits: 1 }, { name: "Sam", email: "sam@x", commits: 1 }],
        files: [{ path: "src/users.js", commits: 2 }],
        functions: [{ id: firstFn.id, name: firstFn.name, file: firstFn.file, startLine: firstFn.startLine, score: firstFn.score, tier: firstFn.tier }],
        firstChange: Date.now() - 1e8, lastChange: Date.now(),
      },
      {
        key: "scope:billing", name: "billing", scope: "billing", primaryType: "bug fix",
        typeCounts: { "bug fix": 1, refactor: 1 },
        commits: [{ hash: "cccc3333", type: "bug fix", title: "rounding", author: "Sam", email: "sam@x", t: Date.now(), files: ["src/billing.js"], breaking: true }],
        authors: [{ name: "Sam", email: "sam@x", commits: 1 }],
        files: [{ path: "src/billing.js", commits: 1 }],
        functions: [{ id: secondFn.id, name: secondFn.name, file: secondFn.file, startLine: secondFn.startLine, score: secondFn.score, tier: secondFn.tier }],
        firstChange: Date.now(), lastChange: Date.now(),
      },
    ],
    people: [
      { name: "Sam", email: "sam@x", commits: 2, features: [{ key: "scope:billing", name: "billing", primaryType: "bug fix", commits: 1 }, { key: "title:get users from db", name: "get users from db", primaryType: "feature", commits: 1 }] },
      { name: "Ada", email: "ada@x", commits: 1, features: [{ key: "title:get users from db", name: "get users from db", primaryType: "feature", commits: 1 }] },
    ],
    totalCommits: 4, taggedCommits: 3,
    untagged: [{ hash: "dddd4444", subject: "added readme", author: "Priya", t: Date.now() }],
    functionsWithHistory: 50, functionsTotal: 60,
    types: ["feature", "bug fix", "hotfix", "refactor", "performance", "security", "test", "docs", "style", "chore"],
  };

  const featTab = doc.querySelector('.tab[data-tab="features"]');
  check("FEATURES tab exists", !!featTab, true);
  click(featTab);
  check("FEATURES tab activates", doc.getElementById("view-features").classList.contains("on"), true);

  window.dispatchEvent(new window.MessageEvent("message", {
    data: Object.assign({}, payload, { protocol: PROTOCOL_VERSION, features: sampleFeatures }),
  }));
  await new Promise((r) => setTimeout(r, 200));
  check("feature cards render", doc.querySelectorAll("#featureList .fcard").length, 2);
  check("summary reports tagging coverage",
    doc.querySelector("#featureList .fsummary").textContent.includes("3 of 4 commits"), true);
  check("type chips reflect present types", doc.querySelectorAll("#typeChips .typechip").length, 2);
  check("no selection shows the format guide", doc.getElementById("featureDetail").textContent.includes("feature: get users from db"), true);

  click(doc.querySelector('#featureList .fcard[data-key="title:get users from db"]'));
  const fdetail = doc.getElementById("featureDetail").textContent;
  check("detail lists who worked on it", fdetail.includes("WHO WORKED ON IT") && fdetail.includes("Ada") && fdetail.includes("Sam"), true);
  check("detail lists files", fdetail.includes("src/users.js"), true);
  check("detail lists functions", fdetail.includes(firstFn.name), true);
  check("detail lists commits", fdetail.includes("aaaa1111"), true);

  // search narrows
  const fsearch = doc.getElementById("featureSearch");
  fsearch.value = "billing";
  fsearch.dispatchEvent(new window.Event("input", { bubbles: true }));
  check("feature search narrows", doc.querySelectorAll("#featureList .fcard").length, 1);
  fsearch.value = "";
  fsearch.dispatchEvent(new window.Event("input", { bubbles: true }));

  // type chip filters
  click(doc.querySelector('#typeChips .typechip[data-type="bug fix"]'));
  check("type chip hides that type", doc.querySelectorAll("#featureList .fcard").length, 1);
  click(doc.querySelector('#typeChips .typechip[data-type="bug fix"]'));

  // by person
  click(doc.getElementById("featureByPerson"));
  check("BY PERSON lists people", doc.querySelectorAll("#featureList .fcard").length, 2);
  click(doc.querySelector('#featureList .fcard[data-email="sam@x"]'));
  check("person shows their features",
    doc.getElementById("featureDetail").textContent.includes("billing") &&
    doc.getElementById("featureDetail").textContent.includes("get users from db"), true);
  click(doc.querySelector('#featureDetail .frow.click[data-key="scope:billing"]'));
  check("clicking a person's feature opens it", doc.getElementById("featureDetail").textContent.includes("BREAKING"), true);

  // show in graph
  click(doc.getElementById("featureShowGraph"));
  check("SHOW IN GRAPH switches to the graph", doc.getElementById("view-graph").classList.contains("on"), true);
  check("feature functions are highlighted", doc.querySelectorAll("g.node.feathit").length, 1);
  check("everything else is dimmed", doc.querySelectorAll("g.node.featdim").length, payload.nodes.length - 1);

  // empty state for a repo with no tagged commits
  window.dispatchEvent(new window.MessageEvent("message", {
    data: Object.assign({}, payload, {
      protocol: PROTOCOL_VERSION,
      features: Object.assign({}, sampleFeatures, { features: [], people: [], taggedCommits: 0, totalCommits: 24 }),
    }),
  }));
  click(featTab);
  await new Promise((r) => setTimeout(r, 150));
  check("untagged repo explains itself", doc.getElementById("featureList").textContent.includes("0 of 24 commits"), true);
  check("untagged repo shows the guide", doc.getElementById("featureDetail").textContent.includes("WRITE COMMITS AS FEATURES"), true);
  check("untagged repo lists recent untagged commits", doc.getElementById("featureDetail").textContent.includes("added readme"), true);
  click(doc.querySelector('.tab[data-tab="graph"]'));

  // ---------------- backups + commands ----------------
  const now = Date.now();
  const mkCmds = (sha) => ({
    preview: `git diff --stat ${sha.slice(0, 12)} -- :/`,
    restore: `sh "$(git rev-parse --absolute-git-dir)/blastradius/backup.sh" pre-restore "x" && git restore --source=${sha.slice(0, 12)} --staged --worktree -- :/`,
    exact: `... && git clean -fd -- :/`,
    file: `git restore --source=${sha.slice(0, 12)} -- <path>`,
  });
  const bOld = { sha: "b0000000000000000000000000000000000000001", t: now - 3600e3, trigger: "interval", head: "aaaa1111ffff", branch: "main",
    headSubject: "feature: get users from db", uncommittedFiles: 2, note: "", author: "Ada", filesChanged: 3, insertions: 10, deletions: 1,
    feature: { key: "title:get users from db", name: "get users from db", type: "feature" } };
  const bNew = { sha: "b0000000000000000000000000000000000000002", t: now - 60e3, trigger: "commit", head: "cccc3333ffff", branch: "main",
    headSubject: "fix(billing): rounding", uncommittedFiles: 0, note: "", author: "Sam", filesChanged: 1, insertions: 2, deletions: 2,
    feature: { key: "scope:billing", name: "billing", type: "bug fix" } };
  const sampleBackups = {
    available: true, enabled: true, branch: "blastradiusbackups", intervalMinutes: 10,
    lastBackupAt: bNew.t, nextBackupAt: now + 540e3,
    hooks: { hooksDir: "/r/.git/hooks", managedExternally: false, prePush: "installed", postCommit: "installed", chained: ["pre-push"], scriptsPresent: true },
    manualInstructions: "# add to your pre-push hook", terminalCapture: true,
    backups: [Object.assign({ commands: mkCmds(bNew.sha) }, bNew), Object.assign({ commands: mkCmds(bOld.sha) }, bOld)],
    timeline: [
      { t: now - 60e3, source: "backup", title: "backup (commit)", detail: "main @ cccc3333", who: "Sam", risk: "safe", why: "",
        sha: bNew.head, subject: bNew.headSubject, feature: bNew.feature, restorePoint: null, backupSha: bNew.sha },
      { t: now - 1800e3, source: "terminal", title: "git reset --hard HEAD~3", detail: "/r", who: "Priya <p@x>", risk: "destructive",
        why: "discards uncommitted changes and can drop commits", exitCode: 0, feature: null,
        restorePoint: { sha: bOld.sha, t: bOld.t } },
      { t: now - 1700e3, source: "terminal", title: "git push --force origin main", detail: "/r", who: "Priya <p@x>", risk: "rewrite",
        why: "rewrites history on the remote", exitCode: 1, feature: null, restorePoint: { sha: bOld.sha, t: bOld.t } },
      { t: now - 2400e3, source: "reflog", title: "commit: feature: get users from db", detail: "", who: "Ada <a@x>", risk: "safe", why: "",
        sha: "aaaa1111ffff", subject: "feature: get users from db", feature: bOld.feature, restorePoint: { sha: bOld.sha, t: bOld.t } },
      { t: now - 3600e3, source: "backup", title: "backup (interval)", detail: "", who: "Ada", risk: "safe", why: "",
        sha: bOld.head, subject: bOld.headSubject, feature: bOld.feature, restorePoint: null, backupSha: bOld.sha },
      { t: now - 5000e3, source: "push-guard", title: "push to origin - backup branch withheld", detail: "every other ref was pushed",
        who: "", risk: "safe", why: "", feature: null, restorePoint: null },
    ],
  };

  // a fresh, non-standalone page, so the host-dependent buttons exist
  const postedB = [];
  const domB = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const wB = domB.window;
  wB.d3 = require("d3");
  applyDomShims(wB);
  wB.acquireVsCodeApi = () => ({ postMessage: (m) => postedB.push(m) });
  global.window = wB; global.document = wB.document; global.SVGElement = wB.SVGElement;
  wB.eval(script);
  wB.dispatchEvent(new wB.MessageEvent("message", { data: Object.assign({}, payload, { protocol: PROTOCOL_VERSION }) }));
  await new Promise((r) => setTimeout(r, 250));
  const dB = wB.document;
  const clickB = (el) => el.dispatchEvent(new wB.MouseEvent("click", { bubbles: true }));

  clickB(dB.querySelector('.tab[data-tab="backups"]'));
  check("BACKUPS tab activates", dB.getElementById("view-backups").classList.contains("on"), true);
  check("opening BACKUPS asks the host for data", postedB.some((m) => m.type === "backups"), true);

  // disabled state first
  wB.dispatchEvent(new wB.MessageEvent("message", { data: Object.assign({}, payload, {
    protocol: PROTOCOL_VERSION,
    backups: Object.assign({}, sampleBackups, { enabled: false, backups: [], timeline: [] }),
  }) }));
  await new Promise((r) => setTimeout(r, 150));
  check("disabled repo explains what enabling does", dB.getElementById("backupList").textContent.includes("pre-push hook"), true);
  clickB(dB.getElementById("backupsEnable"));
  check("TURN ON posts backupsEnable", postedB.some((m) => m.type === "backupsEnable"), true);

  wB.dispatchEvent(new wB.MessageEvent("message", { data: Object.assign({}, payload, { protocol: PROTOCOL_VERSION, backups: sampleBackups }) }));
  await new Promise((r) => setTimeout(r, 150));
  check("backup cards render", dB.querySelectorAll("#backupList .bcard").length, 2);
  check("status shows the push guard is installed", dB.querySelector("#backupList .bstatus").textContent.includes("push guard: installed"), true);
  check("status mentions the chained hook", dB.querySelector("#backupList .bstatus").textContent.includes("pre-push hook still runs"), true);
  clickB(dB.getElementById("backupNow"));
  check("BACK UP NOW posts backupNow", postedB.some((m) => m.type === "backupNow"), true);

  clickB(dB.querySelector(`#backupList .bcard[data-sha="${bOld.sha}"]`));
  const bd = dB.getElementById("backupDetail").textContent;
  check("detail offers a read-only preview", bd.includes("git diff --stat"), true);
  check("detail offers the recommended restore", bd.includes("git restore --source=") && bd.includes("pre-restore"), true);
  check("detail warns about exact restore", bd.includes("Deletes untracked files"), true);
  check("detail lists what happened after the backup", bd.includes("git reset --hard HEAD~3"), true);

  // copy falls back to the host clipboard when the page cannot copy itself
  const copyBtn = dB.querySelector("#backupDetail .copy");
  clickB(copyBtn);
  await new Promise((r) => setTimeout(r, 50));
  check("COPY reaches a clipboard", postedB.some((m) => m.type === "copy" && m.text.includes("git diff --stat")) || copyBtn.textContent === "COPIED", true);

  // feature chip on a backup opens that feature
  wB.dispatchEvent(new wB.MessageEvent("message", { data: Object.assign({}, payload, { protocol: PROTOCOL_VERSION, features: sampleFeatures, backups: sampleBackups }) }));
  await new Promise((r) => setTimeout(r, 100));
  clickB(dB.querySelector('.tab[data-tab="backups"]'));
  clickB(dB.querySelector('#backupList .featlink[data-feature="scope:billing"]'));
  check("feature chip jumps to FEATURES", dB.getElementById("view-features").classList.contains("on"), true);
  check("...with that feature open", dB.getElementById("featureDetail").textContent.includes("rounding"), true);

  // commands timeline
  clickB(dB.querySelector('.tab[data-tab="commands"]'));
  check("COMMANDS tab activates", dB.getElementById("view-commands").classList.contains("on"), true);
  check("timeline renders every event", dB.querySelectorAll("#commandList .tl").length, sampleBackups.timeline.length);
  check("summary counts destructive events", dB.querySelector("#commandList .fsummary").textContent.includes("2 destructive"), true);
  check("destructive commands are labelled", dB.getElementById("commandList").textContent.includes("DESTRUCTIVE"), true);
  check("failed commands show their exit code", !!dB.querySelector("#commandList .exitbad"), true);
  check("the limits of capture are stated", dB.getElementById("commandList").textContent.includes("cannot be seen by git"), true);

  clickB(dB.getElementById("riskyOnly"));
  check("RISKY ONLY keeps just risky events", dB.querySelectorAll("#commandList .tl").length, 2);
  clickB(dB.getElementById("riskyOnly"));

  const csearch = dB.getElementById("commandSearch");
  csearch.value = "Priya";
  csearch.dispatchEvent(new wB.Event("input", { bubbles: true }));
  check("command search finds who ran what", dB.querySelectorAll("#commandList .tl").length, 2);
  csearch.value = "";
  csearch.dispatchEvent(new wB.Event("input", { bubbles: true }));

  clickB(dB.querySelector('#sourceChips .typechip[data-source="terminal"]'));
  check("source chips filter", [...dB.querySelectorAll("#commandList .srcbadge")].every((b) => b.textContent !== "TERMINAL"), true);
  clickB(dB.querySelector('#sourceChips .typechip[data-source="terminal"]'));

  // the reset links to the backup from before it
  const restoreLink = [...dB.querySelectorAll("#commandList .jump[data-backup]")].find((el) => el.textContent.includes("backup b0000000"));
  check("risky command offers its restore point", !!restoreLink, true);
  clickB(restoreLink);
  check("restore point jumps to BACKUPS", dB.getElementById("view-backups").classList.contains("on"), true);
  check("...with that backup selected", !!dB.querySelector(`#backupList .bcard.on[data-sha="${bOld.sha}"]`), true);

  // features interweave: restore points inside a feature
  clickB(dB.querySelector('.tab[data-tab="features"]'));
  clickB(dB.querySelector('#featureList .fcard[data-key="title:get users from db"]'));
  check("feature lists restore points from its commits", dB.getElementById("featureDetail").textContent.includes("RESTORE POINTS FROM THIS FEATURE"), true);
  clickB(dB.querySelector("#featureDetail .jump[data-backup]"));
  check("feature restore point opens the backup", !!dB.querySelector(`#backupList .bcard.on[data-sha="${bOld.sha}"]`), true);

  // core.hooksPath: the missing guard must be loud
  wB.dispatchEvent(new wB.MessageEvent("message", { data: Object.assign({}, payload, {
    protocol: PROTOCOL_VERSION,
    backups: Object.assign({}, sampleBackups, { hooks: Object.assign({}, sampleBackups.hooks, { managedExternally: true, prePush: "missing" }) }),
  }) }));
  await new Promise((r) => setTimeout(r, 100));
  clickB(dB.querySelector('.tab[data-tab="backups"]'));
  check("core.hooksPath warns the guard is not installed", dB.getElementById("backupList").textContent.includes("PUSH GUARD NOT INSTALLED"), true);
  check("...and shows the lines to add", dB.getElementById("backupList").textContent.includes("add to your pre-push hook"), true);

  global.window = window; global.document = window.document; global.SVGElement = window.SVGElement;

  // ---------------- expandable git history ----------------
  click(doc.querySelector('.tab[data-tab="git"]'));
  const gitRow = doc.querySelector("#gitTable tbody tr[data-id]");
  check("git rows show an expander", !!gitRow.querySelector(".expander"), true);
  click(gitRow);
  const hist = doc.querySelector("#gitTable tr.histrow");
  check("clicking a row expands its history", !!hist, true);
  const histText = hist.textContent;
  check("history lists commits or says why not",
    /COMMIT|No commits|has not been read/.test(histText), true);
  click(gitRow);
  check("clicking again collapses it", !doc.querySelector("#gitTable tr.histrow"), true);
  click(doc.querySelector('.tab[data-tab="graph"]'));

  console.log(
    failures ? `\n${failures} FAILURE(S)` : "\nall webview checks passed",
  );
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
