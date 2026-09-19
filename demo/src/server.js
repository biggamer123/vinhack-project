const http = require('http');
const { loadConfig } = require('./config');
const { newServer } = require('./api');
const { trace } = require('./telemetry');

function readBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function start() {
  const config = loadConfig();
  const app = newServer();
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    const result = app.route(app.store, request.method, request.url, body, request);
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.data));
  });
  server.listen(config.port, () => trace('server.listen', { port: config.port }));
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { start };
