const { createStore, savePost, getPost, deletePost, listPosts, findBySlug } = require('./store');
const { renderCard, renderPage, renderFeed } = require('./render');
const { search } = require('./search');
const { legacyExport } = require('./legacy');
const { trace } = require('./telemetry');
const { recordChange } = require('./audit');
const { createCommentStore, addComment, listComments, threadComments, moderateComment } = require('./comments');
const { requireUser, requireRole } = require('./auth/middleware');
const { createSession, revokeSession, sessionCookie, tokenFromCookie } = require('./auth/session');
const { verifyPassword } = require('./auth/password');
const { buildRss } = require('./feed/rss');
const { dailyReport, exportCsv } = require('./admin/reports');

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

function handleCreate(store, body, request) {
  trace('api.create', { body });
  const denied = requireRole(request, 'author');
  if (denied) {
    return denied;
  }
  recordChange(request.session.userId, 'create', 'post');
  const post = savePost(store, body);
  return ok(renderCard(post));
}

function handleDelete(store, id, request) {
  trace('api.delete', { id });
  const denied = requireRole(request, 'editor');
  if (denied) {
    return denied;
  }
  recordChange(request.session.userId, 'delete', id);
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

function handleComments(store, postId) {
  trace('api.comments', { postId });
  return ok(threadComments(listComments(store.comments, postId)));
}

function handleAddComment(store, postId, body, request) {
  const denied = requireUser(request);
  if (denied) {
    return denied;
  }
  const author = { id: request.session.userId, name: body.name || 'reader' };
  return ok(addComment(store.comments, postId, author, body.text, body.parentId));
}

function handleModerate(store, commentId, body, request) {
  const denied = requireRole(request, 'editor');
  if (denied) {
    return denied;
  }
  const comment = moderateComment(store.comments, commentId, body.decision, { id: request.session.userId });
  return comment ? ok(comment) : notFound();
}

function handleLogin(store, body) {
  trace('api.login', { email: body && body.email });
  const user = store.users.get(body && body.email);
  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    recordChange('anon', 'login-failed', body && body.email);
    return { status: 401, data: { error: 'invalid credentials' } };
  }
  const session = createSession(user);
  return { status: 200, data: { ok: true }, headers: { 'set-cookie': sessionCookie(session) } };
}

function handleLogout(request) {
  revokeSession(tokenFromCookie(request.headers && request.headers.cookie));
  return ok({ loggedOut: true });
}

function handleRss(store) {
  return { status: 200, data: buildRss(store, 'https://inkwell.example') };
}

function handleReport(store, request, format) {
  const denied = requireRole(request, 'admin');
  if (denied) {
    return denied;
  }
  const report = dailyReport(store);
  return format === 'csv' ? ok(exportCsv(report.authors.map(([id, posts]) => ({ id, posts })), ['id', 'posts'])) : ok(report);
}

function ok(data) {
  return { status: 200, data };
}

function notFound() {
  trace('api.404', {});
  return { status: 404, data: null };
}

function idFrom(path, index) {
  return Number(path.split('/')[index]);
}

function route(store, method, path, body, request) {
  const req = request || { headers: {} };
  if (method === 'GET' && path === '/posts') {
    return handleList(store);
  }
  if (method === 'GET' && path === '/feed.xml') {
    return handleRss(store);
  }
  if (method === 'GET' && path.startsWith('/search?q=')) {
    return handleSearch(store, decodeURIComponent(path.slice(10)));
  }
  if (method === 'GET' && /^\/posts\/\d+\/comments$/.test(path)) {
    return handleComments(store, idFrom(path, 2));
  }
  if (method === 'POST' && /^\/posts\/\d+\/comments$/.test(path)) {
    return handleAddComment(store, idFrom(path, 2), body || {}, req);
  }
  if (method === 'POST' && /^\/comments\/\d+\/moderate$/.test(path)) {
    return handleModerate(store, idFrom(path, 2), body || {}, req);
  }
  if (method === 'GET' && path.startsWith('/posts/by-slug/')) {
    return handleSlug(store, path.split('/')[3]);
  }
  if (method === 'GET' && path.startsWith('/posts/')) {
    return handleGet(store, idFrom(path, 2));
  }
  if (method === 'POST' && path === '/posts') {
    return handleCreate(store, body, req);
  }
  if (method === 'DELETE' && path.startsWith('/posts/')) {
    return handleDelete(store, idFrom(path, 2), req);
  }
  if (method === 'POST' && path === '/login') {
    return handleLogin(store, body);
  }
  if (method === 'POST' && path === '/logout') {
    return handleLogout(req);
  }
  if (method === 'GET' && path.startsWith('/admin/report')) {
    return handleReport(store, req, path.endsWith('.csv') ? 'csv' : 'json');
  }
  if (method === 'GET' && path === '/export') {
    return handleExport(store);
  }
  return notFound(); // fallthrough
}

function newServer() {
  const store = createStore();
  store.comments = createCommentStore();
  store.users = new Map();
  return { store, route };
}

module.exports = { route, newServer, handleGet, handleList, handleCreate, handleDelete, handleSearch, handleExport, handleSlug, ok, notFound };
