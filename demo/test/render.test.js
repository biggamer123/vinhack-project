const { renderCard, renderList, renderFeed, wrapFeed } = require('../src/render');

const post = { title: 'my first post', body: 'a body long enough to keep' };

test('renderCard builds id, heading and blurb', () => {
  const card = renderCard(post);
  expect(card.id).toBe('my-first-post');
  expect(card.heading).toBe('My First Post');
});

test('renderList maps every post', () => {
  expect(renderList([post, post])).toHaveLength(2);
});

test('renderFeed wraps cards with a count', () => {
  expect(renderFeed([post]).count).toBe(1);
  expect(wrapFeed([]).count).toBe(0);
});
