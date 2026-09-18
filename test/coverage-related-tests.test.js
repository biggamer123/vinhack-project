const test = require('node:test');
const assert = require('node:assert/strict');
const { findTestReferences, extractTestIdentifiers } = require('../out/test-refs.js');

test('findTestReferences resolves a function to matching test cases', () => {
  const text = `
    describe('math helpers', () => {
      it('adds two numbers', () => {
        expect(add(1, 2)).toBe(3);
      });

      it('multiplies values', () => {
        expect(multiply(2, 3)).toBe(6);
      });
    });
  `;

  const refs = findTestReferences(text, 'add');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, 'adds two numbers');
  assert.ok(refs[0].line >= 0);
});

test('does not credit a test with its neighbour\'s functions', () => {
  const text = `
    describe('math helpers', () => {
      it('adds two numbers', () => {
        expect(add(1, 2)).toBe(3);
      });

      it('multiplies values', () => {
        expect(multiply(2, 3)).toBe(6);
      });
    });
  `;

  assert.deepEqual(findTestReferences(text, 'multiply').map((r) => r.name), ['multiplies values']);
  assert.deepEqual((extractTestIdentifiers(text).get('multiply') || []).map((r) => r.name), ['multiplies values']);
  assert.deepEqual((extractTestIdentifiers(text).get('add') || []).map((r) => r.name), ['adds two numbers']);
});
