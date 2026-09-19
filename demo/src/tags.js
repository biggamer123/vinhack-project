const { slugify } = require('./format');

function normalizeTag(tag) {
  return slugify(String(tag)).slice(0, 32);
}

function mergeTags(existing, incoming) {
  return [...new Set([...(existing || []), ...(incoming || [])].map(normalizeTag).filter(Boolean))];
}

function popularTags(posts, limit) {
  const counts = new Map();
  for (const post of posts) {
    for (const tag of post.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit || 10)
    .map(([tag, count]) => ({ tag, count }));
}

module.exports = { normalizeTag, mergeTags, popularTags };
