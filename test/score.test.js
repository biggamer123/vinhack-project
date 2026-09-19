const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRisk, computeScore, tierFor, formulaText } = require('../out/score');

const base = { fanIn: 3, lines: 20, usage: 'active', coveragePct: 50, churnCount: 2, busFactor: 2 };
const risk = (over) => computeRisk({ ...base, ...over });

test('code in use keeps the simple formula', () => {
  // 3*2 + (100-50)/10 + 2 - 2 = 11
  assert.equal(risk({}).score, 11);
  assert.equal(computeScore({ fanIn: 0, coveragePct: null, churnCount: 0, busFactor: 1 }), 5, 'unknown coverage counts as 50%');
  assert.equal(computeScore({ fanIn: 0, coveragePct: 100, churnCount: 0, busFactor: 3 }), 0, 'never below zero');
  assert.equal(risk({ usage: 'entry', fanIn: 0 }).score, 5, 'entry points use the same formula');
});

test('unused code scores minus its line count', () => {
  const small = risk({ usage: 'unused', fanIn: 0, lines: 6 });
  const big = risk({ usage: 'unused', fanIn: 0, lines: 120 });
  assert.equal(small.score, -6);
  assert.equal(big.score, -120);
  assert.equal(small.tier, 'unused');
  assert.equal(risk({ usage: 'exported-unused', fanIn: 0, lines: 9 }).tier, 'unused');
});

test('tiers', () => {
  assert.deepEqual([-1, 0, 14.9, 15, 29, 30, 49, 50].map(tierFor),
    ['unused', 'low', 'low', 'medium', 'medium', 'high', 'high', 'critical']);
});

test('the formula text shows the real numbers', () => {
  assert.equal(formulaText(risk({})), 'score = fanIn*2 + (100 - coverage)/10 + churn - (busFactor > 1 ? 2 : 0) = 3*2 + (100 - 50)/10 + 2 - 2 = 11');
  assert.equal(formulaText(risk({ usage: 'unused', lines: 6 })), 'unused: 0 callers, so score = -lines = -6');
});
