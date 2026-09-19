const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeatureLog, formatFeatureLog, addToFeatureLog, taggedCommits } = require('../out/featureLog');

const commit = (hash, summary) => ({ hash, date: '2026-09-16', who: 'Ada Reyes', summary });

test('a tagged commit survives a write and a read', () => {
  let features = addToFeatureLog([], 'Threaded comments', commit('a1b2c3d4', 'reply chains'), 'feature');
  features = addToFeatureLog(features, 'Threaded comments', commit('b2c3d4e5', 'spam filter'), 'feature');
  features = addToFeatureLog(features, 'Rate limiting', commit('c3d4e5f6', 'token bucket'), 'performance');

  const text = formatFeatureLog(features);
  assert.ok(text.includes('## Threaded comments') && text.includes('- Type: performance'));

  const read = parseFeatureLog(text);
  assert.equal(read.length, 2);
  assert.deepEqual(read[0].commits.map((c) => c.hash), ['b2c3d4e5', 'a1b2c3d4'], 'newest first');
  assert.equal(read[1].type, 'performance');
  assert.equal(taggedCommits(read).get('c3d4e5f6').name, 'Rate limiting');
});

test('re-tagging a commit moves it instead of duplicating it', () => {
  let features = addToFeatureLog([], 'First', commit('aaaaaaaa', 'x'));
  features = addToFeatureLog(features, 'Second', commit('aaaaaaaa', 'x'));
  assert.deepEqual(features.map((f) => f.name), ['Second'], 'an emptied feature is dropped');
  assert.equal(taggedCommits(features).get('aaaaaaaa').name, 'Second');
});

test('pipes in a summary do not break the table', () => {
  const text = formatFeatureLog(addToFeatureLog([], 'Odd', commit('dddddddd', 'fix a | b parsing')));
  const read = parseFeatureLog(text);
  assert.equal(read.length, 1);
  assert.equal(read[0].commits.length, 1);
});
