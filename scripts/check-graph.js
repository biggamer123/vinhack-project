/**
 * Dev helper: run the Stage 1 indexer headlessly over a directory of .js files
 * and print caller/callee counts, so the graph can be sanity-checked without
 * launching the Extension Development Host.
 *
 *   npm run compile && node scripts/check-graph.js <dir>
 */
const path = require('path');
const fs = require('fs');
const { indexSource, initParser } = require('../out/indexer');
const { CallGraph } = require('../out/graph');

const root = path.resolve(process.argv[2] || '.');

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build', 'out', '.git', 'coverage'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(js|jsx|mjs|cjs|ts|mts|cts|tsx|go)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

(async () => {
  await initParser(path.join(__dirname, '..'));
  const graph = new CallGraph();
  const files = walk(root);
  const started = Date.now();
  for (const file of files) {
    graph.setFile(file, indexSource(file, fs.readFileSync(file, 'utf8')));
  }
  graph.resolveEdges();
  console.log(`${files.length} files, ${graph.size} functions, ${graph.callSiteCount} call sites, ${Date.now() - started}ms\n`);
  for (const node of graph.allNodes().sort((a, b) => b.callers.size - a.callers.size).slice(0, 25)) {
    console.log(
      `${String(node.callers.size).padStart(3)} callers  ${node.name}  ` +
        `(${path.relative(root, node.file)}:${node.startLine + 1})`
    );
  }
})();
