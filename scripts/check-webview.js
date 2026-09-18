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
    "callers/callees card rendered",
    doc.querySelectorAll("aside .card").length,
    2,
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

  console.log(
    failures ? `\n${failures} FAILURE(S)` : "\nall webview checks passed",
  );
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
