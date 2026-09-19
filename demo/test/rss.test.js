const { rssItem, escapeXml } = require('../src/feed/rss');

test('escapeXml escapes markup and quotes', () => {
  expect(escapeXml(`<a href="x">'`)).toBe('&lt;a href=&quot;x&quot;&gt;&apos;');
});

test('rssItem links to the post', () => {
  const item = rssItem({ id: 4, title: 'Hi', body: 'body', createdAt: 0 }, 'https://x');
  expect(item).toContain('<link>https://x/posts/4</link>');
});
