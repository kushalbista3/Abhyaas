import test from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS_MESSAGE, TOPIC_CODES, formatQuestionSms, maskPhone } from '../src/sms.js';
import { fitsOneSms } from '../src/gsm7.js';

test('TOPICS message fits one GSM-7 SMS and lists every code', () => {
  assert.ok(fitsOneSms(TOPICS_MESSAGE), TOPICS_MESSAGE);
  for (const code of TOPIC_CODES) assert.match(TOPICS_MESSAGE, new RegExp(`\\b${code}=`));
});

test('question SMS layout', () => {
  const q = { topic: 'PROB', stem: 'S', option_a: '1', option_b: '2', option_c: '3', option_d: '4' };
  assert.equal(formatQuestionSms(q, 7), 'Q7 PROB\nS\nA) 1\nB) 2\nC) 3\nD) 4\nReply A/B/C/D');
});

test('maskPhone hides the middle digits', () => {
  assert.equal(maskPhone('9800000001'), '98******01');
  assert.equal(maskPhone('+9779812345678'), '+9**********78');
  assert.equal(maskPhone('123'), '***');
  assert.equal(maskPhone(null), '');
});
