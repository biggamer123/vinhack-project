const { newServer, route, handleSearch, handleExport } = require('./api');
const { renderPage } = require('./render');
const { savePost } = require('./store');
const { trace } = require('./telemetry');

function seed(server, posts) {
  trace('app.seed', {});
  for (const post of posts) {
    savePost(server.store, post);
  }
  return server;
}

function bootstrap(posts) {
  trace('app.boot', {});
  const server = seed(newServer(), posts);
  return renderPage(posts);
}

const preview = function (post) {
  return renderPage([post]);
};

class Application {
  constructor(posts) {
    this.server = seed(newServer(), posts);
  }

  handle(method, path, body) {
    return route(this.server.store, method, path, body);
  }

  find(query) {
    return handleSearch(this.server.store, query);
  }

  dump() {
    return handleExport(this.server.store);
  }
}

module.exports.main = (posts) => {
  const app = new Application(posts);
  bootstrap(posts);
  return app.handle('GET', '/posts');
};

module.exports.Application = Application;
module.exports.preview = preview;
