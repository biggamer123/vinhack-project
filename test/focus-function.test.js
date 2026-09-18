const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CallGraph } = require('../out/graph');

test('graph keeps the innermost function under the active editor cursor', () => {
  const graph = new CallGraph();
  const file = 'C:/repo/src/app.js';
  graph.setFile(file, {
    nodes: [
      {
        id: 'outer',
        file,
        name: 'outer',
        startLine: 1,
        endLine: 8,
        kind: 'declaration',
        callers: new Set(),
        callees: new Set(),
      },
      {
        id: 'inner',
        file,
        name: 'inner',
        startLine: 3,
        endLine: 5,
        kind: 'declaration',
        callers: new Set(),
        callees: new Set(),
      },
    ],
    callSites: [],
  });

  assert.equal(graph.nodeAtLine(file, 4)?.id, 'inner');
  assert.equal(graph.nodeAtLine(file, 2)?.id, 'outer');
});
