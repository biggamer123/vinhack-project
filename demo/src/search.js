const { slugify } = require('./format');
const { listPosts } = require('./store');
const { trace } = require('./telemetry');

function tokenize(text) {
  return slugify(text).split('-').filter(Boolean);
}

function buildIndex(store) {
  trace('search.index', {});
  const index = new Map();
  for (const post of listPosts(store)) {
    for (const token of tokenize(post.title + ' ' + post.body)) {
      const bucket = index.get(token) || [];
      bucket.push(post.id);
      index.set(token, bucket);
    }
  }
  return index;
}

function scoreMatch(post, tokens) {
  let score = 0;
  for (const token of tokenize(post.title)) {
    if (tokens.includes(token)) {
      score += 3;
    }
  }
  return score;
}

function rankResults(posts, query) {
  const tokens = tokenize(query);
  return posts
    .map((post) => ({ post, score: scoreMatch(post, tokens) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score);
}

function search(store, query) {
  trace('search.run', { query });
  return rankResults(listPosts(store), query);
}

module.exports = { tokenize, buildIndex, scoreMatch, rankResults, search };
