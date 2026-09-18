const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLcov, coverageForRange } = require('../out/lcov');

test('coverage ranges match files across Windows path separators', () => {
  const root = 'C:\\repo';
  const text = [
    'TN:',
    'SF:src\\file.js',
    'DA:1,1',
    'DA:2,0',
    'end_of_record',
    '',
  ].join('\n');

  const index = parseLcov(root, text);
  assert.equal(index.size, 1);
  assert.equal(coverageForRange(index, 'c:\\repo\\src\\file.js', 0, 1), 50);
});
