const { createCommentStore, addComment, threadComments, countReplies, isSpam } = require('../src/comments');

const author = { id: 'u1', name: 'Ada' };

test('addComment stores a visible comment', () => {
  const store = createCommentStore();
  const comment = addComment(store, 1, author, 'Nice post!');
  expect(comment.status).toBe('visible');
});

test('isSpam holds link-stuffed comments', () => {
  expect(isSpam('free money at http://a http://b http://c')).toBe(true);
  expect(isSpam('great write-up')).toBe(false);
});

test('threadComments nests replies and countReplies counts them', () => {
  const thread = threadComments([
    { id: 1, parentId: null },
    { id: 2, parentId: 1 },
    { id: 3, parentId: 2 },
  ]);
  expect(thread).toHaveLength(1);
  expect(countReplies(thread)).toBe(3);
});
