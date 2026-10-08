import test from 'node:test';
import assert from 'node:assert/strict';
import { gsmLength, fitsOneSms, smsSafe, firstFitting } from '../src/gsm7.js';

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

test('smsSafe swaps look-alikes and drops other non-GSM characters', () => {
  assert.equal(smsSafe('“Well” – it’s 5×3 = 15… x² π'), '"Well" - it\'s 5*3 = 15... x^2 pi');
  assert.equal(smsSafe('Namaste अभ्यास 👍 done'), 'Namaste done');
  assert.equal(smsSafe('Q1\nA) 2'), 'Q1\nA) 2', 'newlines kept');
  assert.equal(smsSafe(null), '');
});

test('smsSafe cuts long text to one SMS, counting extension characters as 2', () => {
  const cut = smsSafe('a'.repeat(200));
  assert.equal(cut, 'a'.repeat(157) + '...');
  const ext = smsSafe('^'.repeat(100));
  assert.ok(fitsOneSms(ext), ext);
  assert.equal(ext, '^'.repeat(78) + '...');
  assert.equal(smsSafe('a'.repeat(160)), 'a'.repeat(160), 'exactly 160 is not cut');
  assert.equal(smsSafe('abcdefghij', 8), 'abcde...');
});

test('firstFitting returns the first candidate that fits, else the last one cut', () => {
  assert.equal(firstFitting('x'.repeat(161), 'short', 'other'), 'short');
  assert.equal(firstFitting('“curly”', 'plain'), 'plain', 'non-GSM does not fit');
  assert.equal(firstFitting('x'.repeat(161), 'y'.repeat(170)), 'y'.repeat(157) + '...');
});
