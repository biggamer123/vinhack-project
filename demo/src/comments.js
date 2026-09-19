const { stripTags, truncate } = require('./format');
const { trace } = require('./telemetry');
const { recordChange } = require('./audit');
const { invalidatePrefix, withCache, cacheKey } = require('./cache');
const { notifyFollowers } = require('./notifications');

const BLOCKED_WORDS = ['casino', 'free money', 'crypto giveaway'];

function createCommentStore() {
  return { comments: new Map(), nextId: 1 };
}

function isSpam(body) {
  const lower = body.toLowerCase();
  return BLOCKED_WORDS.some((word) => lower.includes(word)) || (lower.match(/https?:\/\//g) || []).length > 2;
}

function addComment(store, postId, author, body, parentId) {
  trace('comments.add', { postId });
  recordChange(author.id, 'comment', postId);
  const clean = truncate(stripTags(body), 2000);
  const comment = {
    id: store.nextId++,
    postId,
    parentId: parentId || null,
    authorId: author.id,
    body: clean,
    status: isSpam(clean) ? 'held' : 'visible',
    createdAt: Date.now(),
  };
  store.comments.set(comment.id, comment);
  invalidatePrefix(cacheKey('comments', postId));
  if (comment.status === 'visible') {
    notifyFollowers(postId, `${author.name} commented`);
  }
  return comment;
}

function listComments(store, postId) {
  return withCache(cacheKey('comments', postId, 'list'), 30000, () =>
    [...store.comments.values()].filter((c) => c.postId === postId && c.status === 'visible'),
  );
}

function threadComments(comments) {
  const byParent = new Map();
  for (const comment of comments) {
    const key = comment.parentId || 0;
    byParent.set(key, [...(byParent.get(key) || []), comment]);
  }
  const attach = (parentId) =>
    (byParent.get(parentId) || []).map((c) => ({ ...c, replies: attach(c.id) }));
  return attach(0);
}

function countReplies(thread) {
  return thread.reduce((sum, c) => sum + 1 + countReplies(c.replies || []), 0);
}

function moderateComment(store, id, decision, moderator) {
  trace('comments.moderate', { id, decision });
  recordChange(moderator.id, `moderate:${decision}`, id);
  const comment = store.comments.get(id);
  if (!comment) {
    return null;
  }
  if (decision === 'approve') {
    comment.status = 'visible';
  } else if (decision === 'reject') {
    comment.status = 'removed';
  } else {
    throw new Error(`unknown decision ${decision}`);
  }
  invalidatePrefix(cacheKey('comments', comment.postId));
  return comment;
}

module.exports = { createCommentStore, addComment, listComments, threadComments, countReplies, moderateComment, isSpam };
