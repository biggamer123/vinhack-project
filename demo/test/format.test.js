const { slugify, truncate, titleCase, escapeHtml, stripTags, pluralize } = require('../src/format');

test('slugify lowercases and hyphenates', () => {
  expect(slugify('Hello World')).toBe('hello-world');
});

test('truncate leaves short text alone', () => {
  expect(truncate('short', 10)).toBe('short');
  expect(truncate('a much longer string here', 6)).toBe('a much...');
});

test('titleCase capitalizes each word', () => {
  expect(titleCase('hello world')).toBe('Hello World');
});

test('escapeHtml and stripTags', () => {
  expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  expect(stripTags('<b>hi</b>')).toBe('&lt;b&gt;hi&lt;/b&gt;');
});

test('pluralize', () => {
  expect(pluralize('tag', 1)).toBe('tag');
  expect(pluralize('tag', 3)).toBe('tags');
});
