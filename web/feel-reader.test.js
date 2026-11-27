import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createFeelReader, outcomeLine, scheduleWords } from './feel-reader.js';

const passage = 'Practice this! Keep reading.';
const engine = {
  tokenize: (text) => text.split(/\s+/).map((word) => ({
    text: word,
    pauseMultiplier: /[.!?]$/.test(word) ? 2 : 1,
  })),
  computeOrp: (word) => ({ before: '', pivot: word[0], after: word.slice(1) }),
  tokenDelay: (token, wpm) => 60000 / wpm * token.pauseMultiplier,
};

function fakeClock(win) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const nextTimer = () => [...timers.values()].sort((a, b) => a.at - b.at)[0];

  Object.defineProperty(win.performance, 'now', { value: () => now });
  win.Date.now = () => now;
  win.setTimeout = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { id, callback, at: now + delay, delay });
    return id;
  };
  win.clearTimeout = (id) => timers.delete(id);

  function advanceTo(target) {
    let timer = nextTimer();
    while (timer && timer.at <= target) {
      timers.delete(timer.id);
      now = timer.at;
      timer.callback();
      timer = nextTimer();
    }
    now = target;
  }

  return {
    advanceTo,
    advanceBy: (delay) => advanceTo(now + delay),
    nextTimer,
  };
}

function browser(t, { reducedMotion = false, observe = true } = {}) {
  const { window: win } = new JSDOM('<main><p>Previous contents</p></main>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
  });
  const clock = fakeClock(win);
  const doc = win.document;
  const root = doc.querySelector('main');
  let hidden = false;
  let observer;
  let reader;

  t.after(() => {
    reader?.destroy();
    win.close();
  });
  Object.defineProperty(doc, 'hidden', { get: () => hidden });
  win.matchMedia = (query) => ({
    matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
  });

  if (observe) {
    win.IntersectionObserver = class {
      constructor(callback, { threshold }) {
        this.callback = callback;
        this.threshold = threshold;
        this.disconnected = false;
        observer = this;
      }

      observe(target) {
        this.target = target;
      }

      disconnect() {
        this.disconnected = true;
      }
    };
  }

  return {
    win,
    root,
    clock,
    get observer() { return observer; },
    get word() { return root.querySelector('.feel-reader-word').textContent; },
    get toggle() { return root.querySelector('.feel-reader-toggle'); },
    get outcome() { return root.querySelector('.feel-reader-outcome'); },
    create(options = {}) {
      reader = createFeelReader({
        root,
        text: passage,
        wpm: 300,
        measuredWpm: 200,
        engine,
        ...options,
      });
      return reader;
    },
    setIntersection(intersectionRatio) {
      observer?.callback([{
        target: observer.target,
        isIntersecting: intersectionRatio > 0,
        intersectionRatio,
      }], observer);
    },
    setHidden(value) {
      hidden = value;
      doc.dispatchEvent(new win.Event('visibilitychange'));
    },
  };
}

test('word timings equal tokenDelay at the given wpm', (t) => {
  const tokens = engine.tokenize(passage);
  for (const wpm of [300, 450]) {
    const expected = tokens.map((token) => ({
      text: token.text,
      delay: engine.tokenDelay(token, wpm),
    }));
    assert.deepEqual(scheduleWords(tokens, wpm, engine.tokenDelay), expected);

    const page = browser(t);
    const reader = page.create({ wpm, autoplay: false });
    reader.play();
    for (const { text, delay } of expected) {
      assert.equal(page.word, text);
      const timer = page.clock.nextTimer();
      assert.equal(timer.delay, delay);
      page.clock.advanceTo(timer.at - 1);
      assert.equal(page.word, text);
      assert.equal(reader.state, 'playing');
      page.clock.advanceTo(timer.at);
    }
    assert.equal(reader.state, 'finished');
    assert.equal(page.clock.nextTimer(), undefined);
  }
});

test('outcomeLine reports faster, equal, slower, and missing measured speeds', () => {
  assert.equal(outcomeLine(450, 300), 'That was 450 words per minute, 50% faster than you just read.');
  assert.equal(outcomeLine(300, 300), 'That was 300 words per minute, at your pace.');
  assert.equal(outcomeLine(200, 224), 'That was 200 words per minute, 11% slower than you just read.');
  assert.equal(outcomeLine(200), 'That was 200 words per minute, at your pace.');
  assert.equal(outcomeLine(1250, 900), 'That was 1,250 words per minute, 39% faster than you just read.');
});

test('renders the word spans, full text, toggle, and status', (t) => {
  const page = browser(t);
  const reader = page.create({ autoplay: false });
  assert.equal(page.root.textContent.includes('Previous contents'), false);
  const word = page.root.querySelector('.feel-reader-word');
  assert.equal(word.getAttribute('aria-hidden'), 'true');
  assert.deepEqual([...word.children].map((child) => [child.tagName, child.className]), [
    ['SPAN', 'feel-reader-before'],
    ['SPAN', 'feel-reader-pivot'],
    ['SPAN', 'feel-reader-after'],
  ]);
  assert.equal(page.root.querySelector('p.feel-reader-sr').textContent, passage);
  assert.equal(page.toggle.tagName, 'BUTTON');
  assert.equal(page.toggle.type, 'button');
  assert.equal(page.toggle.textContent, 'Play');
  assert.equal(page.outcome.getAttribute('role'), 'status');
  assert.equal(page.outcome.textContent, '');

  page.toggle.click();
  assert.equal(reader.state, 'playing');
  assert.equal(page.toggle.textContent, 'Pause');
  assert.equal(word.querySelector('.feel-reader-pivot').textContent, 'P');
  assert.equal(word.querySelector('.feel-reader-after').textContent, 'ractice');
});

test('autoplay starts once at 60% intersection', (t) => {
  const page = browser(t);
  const reader = page.create();
  assert.equal(page.observer.target, page.root);
  assert.ok([page.observer.threshold].flat().includes(0.6));
  assert.equal(reader.state, 'idle');
  page.setIntersection(0.5);
  assert.equal(reader.state, 'idle');
  assert.equal(page.toggle.textContent, 'Play');
  page.setIntersection(0.6);
  assert.equal(reader.state, 'playing');

  page.clock.advanceBy(1200);
  assert.equal(reader.state, 'finished');
  page.setIntersection(0.5);
  page.setIntersection(0.9);
  assert.equal(reader.state, 'finished');
});

test('reduced motion waits for the visitor to press Play', (t) => {
  const page = browser(t, { reducedMotion: true });
  const reader = page.create();
  page.setIntersection(0.8);
  assert.equal(reader.state, 'idle');
  assert.equal(page.toggle.textContent, 'Play');
  page.toggle.click();
  assert.equal(reader.state, 'playing');
});

test('autoplay false waits for the visitor to press Play', (t) => {
  const page = browser(t);
  const reader = page.create({ autoplay: false });
  page.setIntersection(0.8);
  assert.equal(reader.state, 'idle');
  assert.equal(page.toggle.textContent, 'Play');
  page.toggle.click();
  assert.equal(reader.state, 'playing');
});

test('missing IntersectionObserver leaves manual Play available', (t) => {
  const page = browser(t, { observe: false });
  const reader = page.create();
  assert.equal(reader.state, 'idle');
  assert.equal(page.toggle.textContent, 'Play');
  page.toggle.click();
  assert.equal(reader.state, 'playing');
});

test('tab visibility pauses and resumes at the remaining delay', (t) => {
  const page = browser(t);
  const reader = page.create();
  page.setIntersection(0.8);
  page.clock.advanceBy(50);
  page.setHidden(true);
  assert.equal(reader.state, 'paused');
  assert.equal(page.clock.nextTimer(), undefined);
  page.clock.advanceBy(500);
  assert.equal(page.word, 'Practice');

  page.setHidden(false);
  assert.equal(reader.state, 'playing');
  page.clock.advanceBy(149);
  assert.equal(page.word, 'Practice');
  page.clock.advanceBy(1);
  assert.equal(page.word, 'this!');
});

test('visibility and intersection changes respect a visitor pause', (t) => {
  const page = browser(t);
  const reader = page.create();
  page.setIntersection(0.8);
  page.clock.advanceBy(50);
  page.toggle.click();
  assert.equal(reader.state, 'paused');
  assert.equal(page.toggle.textContent, 'Play');

  page.setHidden(true);
  page.setIntersection(0.5);
  page.setHidden(false);
  page.setIntersection(0.8);
  page.clock.advanceBy(500);
  assert.equal(reader.state, 'paused');
  assert.equal(page.word, 'Practice');
  page.toggle.click();
  assert.equal(reader.state, 'playing');
  page.clock.advanceBy(150);
  assert.equal(page.word, 'this!');
});

test('offscreen playback resumes only when the reader is in view and the tab is visible', (t) => {
  const page = browser(t);
  const reader = page.create();
  page.setIntersection(0.8);
  page.clock.advanceBy(100);
  page.setIntersection(0.5);
  assert.equal(reader.state, 'paused');
  assert.equal(page.clock.nextTimer(), undefined);
  page.setHidden(true);
  page.setIntersection(0.8);
  page.clock.advanceBy(500);
  assert.equal(reader.state, 'paused');
  assert.equal(page.word, 'Practice');

  page.setHidden(false);
  assert.equal(reader.state, 'playing');
  page.clock.advanceBy(99);
  assert.equal(page.word, 'Practice');
  page.clock.advanceBy(1);
  assert.equal(page.word, 'this!');
});

test('onFinished runs once after the outcome is written and state is finished', (t) => {
  const page = browser(t);
  let calls = 0;
  const reader = page.create({
    onFinished() {
      calls += 1;
      assert.equal(page.outcome.textContent, 'That was 300 words per minute, 50% faster than you just read.');
      assert.equal(reader.state, 'finished');
    },
  });
  reader.play();
  page.clock.advanceBy(1199);
  assert.equal(calls, 0);
  assert.equal(page.outcome.textContent, '');
  page.clock.advanceBy(1);
  assert.equal(calls, 1);
  assert.equal(page.toggle.textContent, 'Play again');

  page.toggle.click();
  assert.equal(reader.state, 'playing');
  assert.equal(page.word, 'Practice');
  page.clock.advanceBy(1200);
  assert.equal(reader.state, 'finished');
  assert.equal(calls, 1);
});

test('reader never accesses localStorage, sessionStorage, or cookies', (t) => {
  const page = browser(t);
  const accesses = [];
  for (const [object, property] of [
    [page.win, 'localStorage'],
    [page.win, 'sessionStorage'],
    [page.win.document, 'cookie'],
  ]) {
    const spy = () => {
      accesses.push(property);
      throw new Error(`Unexpected ${property} access`);
    };
    Object.defineProperty(object, property, { configurable: true, get: spy, set: spy });
  }

  const reader = page.create();
  page.setIntersection(0.8);
  page.clock.advanceBy(1200);
  assert.equal(reader.state, 'finished');
  reader.destroy();
  assert.deepEqual(accesses, []);
});

test('destroy clears the timer, disconnects the observer, and removes visibility handling', (t) => {
  const page = browser(t);
  const removeListener = t.mock.method(page.win.document, 'removeEventListener');
  let finishCalls = 0;
  const reader = page.create({ onFinished: () => { finishCalls += 1; } });
  page.setIntersection(0.8);
  assert.ok(page.clock.nextTimer());
  assert.equal(page.observer.disconnected, false);

  reader.destroy();
  assert.equal(page.clock.nextTimer(), undefined);
  assert.equal(page.observer.disconnected, true);
  assert.ok(removeListener.mock.calls.some(({ arguments: args }) => args[0] === 'visibilitychange'));
  page.setHidden(true);
  page.setHidden(false);
  page.clock.advanceBy(1200);
  assert.equal(finishCalls, 0);
});

test('pressing Play works even when less than 60% of the reader is in view', (t) => {
  const page = browser(t, { reducedMotion: true });
  const reader = page.create();
  page.setIntersection(0.49);
  page.toggle.click();
  assert.equal(reader.state, 'playing');
  page.setIntersection(0);
  assert.equal(reader.state, 'paused', 'scrolling it away still pauses it');
});
