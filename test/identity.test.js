const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIdentities, githubLogin } = require('../out/identity');

test('a GitHub noreply email merges with the same person', () => {
  const people = buildIdentities([
    { name: 'Atharva Sharma', email: 'atharva17asm@gmail.com', count: 54 },
    { name: 'Atharva Sharma', email: '52234477+atharvaSharma17@users.noreply.github.com', count: 1 },
    { name: 'Advik-Gupta', email: 'codecheflover@gmail.com', count: 80 },
    { name: 'advik gupta', email: '99+Advik-Gupta@users.noreply.github.com', count: 2 },
  ]);
  const atharva = people.get('52234477+atharvasharma17@users.noreply.github.com');
  assert.deepEqual(atharva, { name: 'Atharva Sharma', email: 'atharva17asm@gmail.com' });
  assert.equal(people.get('99+advik-gupta@users.noreply.github.com').email, 'codecheflover@gmail.com', 'joined by GitHub login');
  assert.notEqual(people.get('codecheflover@gmail.com').email, atharva.email);
  assert.equal(githubLogin('someone@example.com'), undefined);
});
