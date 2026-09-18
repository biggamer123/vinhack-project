const { hasTitle, hasBody, isValidPost } = require('../src/validate');

test('hasTitle', () => {
  expect(hasTitle({ title: 'x' })).toBe(true);
  expect(hasTitle({})).toBe(false);
});

test('isValidPost requires title and body', () => {
  expect(isValidPost({ title: 'x', body: 'long enough body' })).toBe(true);
  expect(isValidPost(null)).toBe(false);
  expect(hasBody({ body: 'short' })).toBe(false);
});
