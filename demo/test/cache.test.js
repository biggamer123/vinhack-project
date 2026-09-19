const { cacheKey, cacheGet, cacheSet, invalidatePrefix, withCache } = require('../src/cache');

test('cacheSet then cacheGet', () => {
  cacheSet('a', 1);
  expect(cacheGet('a')).toBe(1);
});

test('invalidatePrefix removes matching keys', () => {
  cacheSet(cacheKey('comments', 7, 'list'), []);
  expect(invalidatePrefix('comments:7')).toBe(1);
});

test('withCache computes once', () => {
  let calls = 0;
  withCache('once', 1000, () => ++calls);
  withCache('once', 1000, () => ++calls);
  expect(calls).toBe(1);
});
