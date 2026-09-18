const { slugify, truncate, titleCase, escapeHtml, pluralize } = require('./format');
const { trace } = require('./telemetry');

function renderCard(post) {
  return {
    id: slugify(post.title),
    heading: titleCase(post.title),
    blurb: truncate(post.body, 140),
  };
}

function renderHero(post) {
  const card = renderCard(post);
  card.hero = true;
  card.banner = escapeHtml(post.title);
  return card;
}

function renderList(posts) {
  return posts.map((post) => renderCard(post));
}

function renderTagLine(tags) {
  return tags.length + ' ' + pluralize('tag', tags.length);
}

function wrapFeed(cards) {
  return { count: cards.length, cards };
}

function renderFeed(posts) {
  const cards = renderList(posts);
  return wrapFeed(cards);
}

function renderPage(posts) {
  trace('render.page', {});
  const feed = renderFeed(posts);
  const hero = renderHero(posts[0]);
  return { hero, feed };
}

module.exports = { renderCard, renderHero, renderList, renderFeed, renderPage, wrapFeed, renderTagLine };
