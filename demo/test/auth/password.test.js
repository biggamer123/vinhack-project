const { hashPassword, verifyPassword, needsRehash, isStrongPassword } = require('../../src/auth/password');

test('hashPassword output verifies with verifyPassword', () => {
  const stored = hashPassword('Correct-Horse-9', 'fixed-salt');
  expect(verifyPassword('Correct-Horse-9', stored)).toBe(true);
  expect(verifyPassword('wrong', stored)).toBe(false);
});

test('needsRehash flags old iteration counts', () => {
  expect(needsRehash('pbkdf2$1000$salt$abc')).toBe(true);
  expect(needsRehash(hashPassword('Another-Pass-1'))).toBe(false);
});

test('isStrongPassword wants length, a digit and a capital', () => {
  expect(isStrongPassword('short')).toBe(false);
  expect(isStrongPassword('Long-Enough-Pass-1')).toBe(true);
});
