const { slugify } = require('./format');
const { assertPost } = require('./validate');
const { trace } = require('./telemetry');
const { recordChange } = require('./audit');

function createStore() {
  return { posts: new Map(), index: new Map() };
}

function indexPost(store, post) {
  trace('store.index', {});
  recordChange('store', 'index', 'post');
  const key = slugify(post.title);
  store.index.set(key, post.id);
  return key;
}

function savePost(store, raw) {
  trace('store.save', {});
  recordChange('store', 'save', 'post');
  const post = assertPost(raw);
  post.id = nextId(store);
  post.createdAt = Date.now();
  store.posts.set(post.id, post);
  indexPost(store, post);
  // TODO: reindex on update too
  return post;
}

function nextId(store) {
  return store.posts.size + 1;
}

function getPost(store, id) {
  return store.posts.get(id) || null;
}

function findBySlug(store, slug) {
  const id = store.index.get(slug);
  return getPost(store, id);
}

function listPosts(store) {
  return [...store.posts.values()];
}

function deletePost(store, id) {
  trace('store.delete', { id });
  recordChange('store', 'delete', id);
  const post = getPost(store, id);
  if (!post) {
    return false;
  }
  store.posts.delete(id);
  return true;
}

module.exports = { createStore, savePost, getPost, findBySlug, listPosts, deletePost, indexPost, nextId };
