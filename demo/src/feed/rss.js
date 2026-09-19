const { truncate } = require('../format');
const { listPosts } = require('../store');
const { withCache } = require('../cache');

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rssItem(post, baseUrl) {
  return [
    '<item>',
    `<title>${escapeXml(post.title)}</title>`,
    `<link>${baseUrl}/posts/${post.id}</link>`,
    `<description>${escapeXml(truncate(post.body, 280))}</description>`,
    `<pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>`,
    '</item>',
  ].join('');
}

function buildRss(store, baseUrl) {
  return withCache('feed:rss', 60000, () => {
    const items = listPosts(store).slice(-20).reverse().map((post) => rssItem(post, baseUrl));
    return `<?xml version="1.0"?><rss version="2.0"><channel><title>Inkwell</title>${items.join('')}</channel></rss>`;
  });
}

module.exports = { buildRss, rssItem, escapeXml };
