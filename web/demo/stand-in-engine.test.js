import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, computeOrp, tokenDelay, practicePace, engine } from './stand-in-engine.js';
import { scheduleWords } from '../feel-reader.js';

test('tokenize splits on whitespace', () => {
  assert.deepEqual(tokenize('  one two\nthree  '), [{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  assert.deepEqual(tokenize(''), []);
});

test('computeOrp picks the pivot by word length', () => {
  assert.deepEqual(computeOrp('a'), { before: '', pivot: 'a', after: '' });
  assert.deepEqual(computeOrp('is'), { before: 'i', pivot: 's', after: '' });
  assert.deepEqual(computeOrp('quiet'), { before: 'q', pivot: 'u', after: 'iet' });
  assert.deepEqual(computeOrp('morning'), { before: 'mo', pivot: 'r', after: 'ning' });
  assert.deepEqual(computeOrp('remarkable'), { before: 'rem', pivot: 'a', after: 'rkable' });
  assert.deepEqual(computeOrp('extraordinarily'), { before: 'extr', pivot: 'a', after: 'ordinarily' });
});

test('computeOrp ignores trailing punctuation when measuring', () => {
  assert.deepEqual(computeOrp('quiet,'), { before: 'q', pivot: 'u', after: 'iet,' });
  assert.deepEqual(computeOrp('a.'), { before: '', pivot: 'a', after: '.' });
});

test('tokenDelay is 60000/wpm for a plain word and pauses after punctuation', () => {
  assert.equal(tokenDelay({ text: 'word' }, 300), 200);
  assert.equal(tokenDelay({ text: 'word.' }, 300), 400);
  assert.equal(tokenDelay({ text: 'word!' }, 300), 400);
  assert.equal(tokenDelay({ text: 'word?' }, 300), 400);
  assert.equal(tokenDelay({ text: 'word,' }, 300), 300);
  assert.equal(tokenDelay({ text: 'word;' }, 300), 300);
  assert.equal(tokenDelay({ text: 'word:' }, 300), 300);
});

test('scheduleWords with the stand-in engine gives tokenDelay at the given wpm', () => {
  const tokens = engine.tokenize('Slow down, then speed up. Done');
  const schedule = scheduleWords(tokens, 240, engine.tokenDelay);
  assert.equal(schedule.length, tokens.length);
  schedule.forEach((item, i) => {
    assert.equal(item.text, tokens[i].text);
    assert.equal(item.delay, tokenDelay(tokens[i], 240));
  });
  assert.equal(schedule[0].delay, 250);
});

test('practicePace is 1.2x rounded to the nearest 10', () => {
  assert.equal(practicePace(250), 300);
  assert.equal(practicePace(237), 280);
});
