const { createStore, savePost, getPost, deletePost, listPosts, findBySlug } = require('./store');
const { renderCard, renderPage, renderFeed } = require('./render');
const { search } = require('./search');
const { legacyExport } = require('./legacy');
const { trace } = require('./telemetry');
const { recordChange } = require('./audit');

function handleGet(store, id) {
  trace('api.get', { id });
  recordChange('web', 'read', id);
  const post = getPost(store, id);
  if (!post) {
    return notFound();
  }
  return ok(renderCard(post));
}

function handleList(store) {
  trace('api.list', {});
  recordChange('web', 'list', 'posts');
  return ok(renderFeed(listPosts(store)));
}

function handleCreate(store, body) {
  trace('api.create', { body });
  recordChange('web', 'create', 'post');
  const post = savePost(store, body);
  return ok(renderCard(post));
}

function handleDelete(store, id) {
  trace('api.delete', { id });
  recordChange('web', 'delete', id);
  if (!deletePost(store, id)) {
    return notFound();
  }
  return ok({ deleted: id });
}

function handleSearch(store, query) {
  trace('api.search', { query });
  recordChange('web', 'search', query);
  return ok(search(store, query));
}

function handleExport(store) {
  trace('api.export', {});
  recordChange('web', 'export', 'all');
  return ok(legacyExport(store, { width: 60 }));
}

function handleSlug(store, slug) {
  trace('api.slug', { slug });
  recordChange('web', 'read', slug);
  const post = findBySlug(store, slug);
  return post ? ok(renderCard(post)) : notFound();
}

function ok(data) {
  return { status: 200, data };
}

function notFound() {
  trace('api.404', {});
  return { status: 404, data: null };
}

function route(store, method, path, body) {
  if (method === 'GET' && path === '/posts') {
    return handleList(store);
  }
  if (method === 'GET' && path.startsWith('/posts/')) {
    return handleGet(store, Number(path.split('/')[2]));
  }
  if (method === 'POST' && path === '/posts') {
    return handleCreate(store, body);
  }
  if (method === 'DELETE' && path.startsWith('/posts/')) {
    return handleDelete(store, Number(path.split('/')[2]));
  }
  return notFound(); // fallthrough
}

function newServer() {
  return { store: createStore(), route };
}

module.exports = { route, newServer, handleGet, handleList, handleCreate, handleDelete, handleSearch, handleExport, handleSlug, ok, notFound };
