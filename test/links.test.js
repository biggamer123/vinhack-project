const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../out/dockerTemplates');

function stackOf(templates) {
  const stack = { projectName: 'app', mode: 'development', services: [] };
  const made = {};
  for (const t of templates) {
    const svc = D.newService(t, stack, `${t}-${stack.services.length}`);
    stack.services.push(svc);
    made[t] = made[t] ? [...made[t], svc] : [svc];
  }
  return { stack, made };
}
const compose = (stack) => D.generateStack(stack).files.find((f) => f.path === 'docker-compose.yml').content;

test('by default apps connect to the data services and frontends to an api', () => {
  const { stack, made } = stackOf(['react-vite', 'express', 'postgres']);
  const links = D.linksOf(stack).map((l) => `${l.from}->${l.to}`);
  assert.deepEqual(links.sort(), ['express-1->postgres-2', 'react-vite-0->express-1']);
  assert.ok(compose(stack).includes('DATABASE_URL'));
  void made;
});

test('two backends can use different data services', () => {
  const { stack, made } = stackOf(['express', 'fastapi', 'redis', 'postgres']);
  const [one] = made.express;
  const [two] = made.fastapi;
  const [redis] = made.redis;
  // Only the first backend keeps redis.
  stack.links = D.linksOf(stack).filter((l) => !(l.from === two.id && l.to === redis.id));
  const yml = compose(stack);
  const block = (name) => yml.split(/^  (?=\S)/m).find((b) => b.startsWith(name + ':'));
  assert.ok(block(one.name).includes('REDIS_URL'), 'the connected backend gets redis');
  assert.ok(!block(two.name).includes('REDIS_URL'), 'the disconnected one does not');
  assert.ok(block(two.name).includes('DATABASE_URL'), 'it still gets the database it is connected to');
  assert.ok(block(one.name).includes(`${redis.name}:`) && !block(two.name).includes(`${redis.name}:`), 'depends_on follows too');
});

test('a data service nothing connects to is reported', () => {
  const { stack, made } = stackOf(['express', 'redis']);
  stack.links = [];
  const gen = D.generateStack(stack);
  assert.ok(gen.warnings.some((w) => w.includes(made.redis[0].name)), gen.warnings.join(' | '));
});

test('links to services that were removed are ignored', () => {
  const { stack } = stackOf(['express', 'postgres']);
  stack.links = [...D.linksOf(stack), { from: 'gone', to: 'also-gone' }];
  assert.equal(D.linksOf(stack).length, 1);
});
