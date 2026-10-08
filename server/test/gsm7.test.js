import test from 'node:test';
import assert from 'node:assert/strict';
import { gsmLength, fitsOneSms } from '../src/gsm7.js';

test('basic characters count 1', () => {
  assert.equal(gsmLength('Reply A/B/C/D'), 13);
  assert.equal(gsmLength('Rs 100, 13% VAT\n'), 16);
});

test('extension characters count 2', () => {
  assert.equal(gsmLength('x^2'), 4);
  assert.equal(gsmLength('{}[]~|\\'), 14);
  assert.equal(gsmLength('€5'), 3);
});

test('Devanagari, emoji and smart quotes are rejected', () => {
  assert.equal(gsmLength('अभ्यास'), null);
  assert.equal(gsmLength('Well done 👍'), null);
  assert.equal(gsmLength('“quote”'), null);
  assert.equal(gsmLength('x²'), null);
});

test('fitsOneSms counts septets, not JS string length', () => {
  assert.equal(fitsOneSms('a'.repeat(160)), true);
  assert.equal(fitsOneSms('a'.repeat(159) + '^'), false);
});
