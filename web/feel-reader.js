/** Pair each token's text with the engine's delay at the given pace. */
export function scheduleWords(tokens, wpm, tokenDelay) {
  return tokens.map((token) => ({ text: token.text, delay: tokenDelay(token, wpm) }));
}

/** Describe how the practice pace compares with the visitor's measured pace. */
export function outcomeLine(practiceWpm, measuredWpm) {
  const pace = practiceWpm.toLocaleString('en-US');
  const improvement = measuredWpm > 0 ? Math.round((practiceWpm / measuredWpm - 1) * 100) : 0;
  return improvement > 0
    ? `That was ${pace} words per minute, ${improvement}% faster than you just read.`
    : `That was ${pace} words per minute, at your pace.`;
}

/** Mount a one-word-at-a-time reader using the supplied reading engine. */
export function createFeelReader({
  root, text, wpm, measuredWpm, engine, onFinished, autoplay = true,
  win = root.ownerDocument.defaultView,
}) {
  const doc = root.ownerDocument;
  const words = scheduleWords(engine.tokenize(text), wpm, engine.tokenDelay);
  const word = doc.createElement('div');
  word.className = 'feel-reader-word';
  word.setAttribute('aria-hidden', 'true');
  const parts = ['before', 'pivot', 'after'].map((part) => {
    const span = doc.createElement('span');
    span.className = `feel-reader-${part}`;
    return span;
  });
  word.append(...parts);

  const transcript = doc.createElement('p');
  transcript.className = 'feel-reader-sr';
  transcript.textContent = text;
  Object.assign(transcript.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  });

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'feel-reader-toggle';
  toggle.textContent = 'Play';
  const outcome = doc.createElement('p');
  outcome.className = 'feel-reader-outcome';
  outcome.setAttribute('role', 'status');
  root.replaceChildren(word, transcript, toggle, outcome);

  const threshold = 0.6;
  const now = () => win.performance?.now() ?? Date.now();
  let mayAutoplay = autoplay && !win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let state = 'idle';
  let wantsPlayback = false;
  let inView = true;
  let destroyed = false;
  let notified = false;
  let index = 0;
  let remaining = words[0]?.delay ?? 0;
  let deadline;
  let timer;

  function setState(nextState) {
    state = nextState;
    toggle.textContent = { idle: 'Play', playing: 'Pause', paused: 'Play', finished: 'Play again' }[state];
  }

  function showWord() {
    const { before, pivot, after } = engine.computeOrp(words[index].text);
    parts[0].textContent = before;
    parts[1].textContent = pivot;
    parts[2].textContent = after;
  }

  function finish() {
    wantsPlayback = false;
    outcome.textContent = outcomeLine(wpm, measuredWpm);
    setState('finished');
    if (!notified) {
      notified = true;
      onFinished?.();
    }
  }

  function startTimer() {
    deadline = now() + remaining;
    timer = win.setTimeout(advance, remaining);
  }

  function advance() {
    timer = undefined;
    index += 1;
    if (index === words.length) {
      finish();
      return;
    }
    remaining = words[index].delay;
    showWord();
    startTimer();
  }

  function syncPlayback() {
    if (destroyed) return;
    if (!wantsPlayback || doc.hidden || !inView) {
      if (state === 'playing') {
        remaining = Math.max(0, deadline - now());
        win.clearTimeout(timer);
        timer = undefined;
        setState('paused');
      }
      return;
    }
    if (state === 'playing') return;
    if (words.length === 0) {
      finish();
      return;
    }
    if (state === 'finished') {
      index = 0;
      remaining = words[0].delay;
      outcome.textContent = '';
    }
    if (state !== 'paused') showWord();
    setState('playing');
    startTimer();
  }

  function play() {
    mayAutoplay = false;
    wantsPlayback = true;
    syncPlayback();
  }

  function pause() {
    mayAutoplay = false;
    wantsPlayback = false;
    syncPlayback();
  }

  function onToggle() {
    if (state === 'playing') pause();
    else play();
  }

  const observer = typeof win.IntersectionObserver === 'function'
    ? new win.IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        inView = entry.intersectionRatio >= threshold;
        if (inView && mayAutoplay) play();
        else syncPlayback();
      }, { threshold })
    : undefined;

  toggle.addEventListener('click', onToggle);
  doc.addEventListener('visibilitychange', syncPlayback);
  observer?.observe(root);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    toggle.removeEventListener('click', onToggle);
    doc.removeEventListener('visibilitychange', syncPlayback);
    observer?.disconnect();
    if (timer !== undefined) win.clearTimeout(timer);
  }

  return { play, pause, destroy, get state() { return state; } };
}
