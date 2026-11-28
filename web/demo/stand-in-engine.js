// STAND-IN engine for the demo. Not ReadSharp's engine.
// It only has the same shape (tokenize, computeOrp, tokenDelay) that web/feel-reader.js expects.

/** Split text on whitespace into tokens. */
export function tokenize(text) {
  return String(text).split(/\s+/).filter(Boolean).map((word) => ({ text: word }));
}

/** Pick the pivot letter by word length (trailing punctuation is not measured). */
export function computeOrp(word) {
  const length = word.replace(/[^\p{L}\p{N}]+$/u, '').length;
  if (length === 0) return { before: '', pivot: word.slice(0, 1), after: word.slice(1) };
  let index = 4;
  if (length === 1) index = 0;
  else if (length <= 5) index = 1;
  else if (length <= 9) index = 2;
  else if (length <= 13) index = 3;
  return { before: word.slice(0, index), pivot: word[index], after: word.slice(index + 1) };
}

/** Milliseconds to show a token: 60000 / wpm, plus a pause after punctuation. */
export function tokenDelay(token, wpm) {
  const base = 60000 / wpm;
  const last = token.text.slice(-1);
  if ('.!?'.includes(last)) return base * 2;
  if (',;:'.includes(last)) return base * 1.5;
  return base;
}

/** STAND-IN practice pace: 1.2x the measured speed, rounded to the nearest 10. */
export function practicePace(speedWpm) {
  return Math.round((speedWpm * 1.2) / 10) * 10;
}

export const engine = Object.freeze({ tokenize, computeOrp, tokenDelay });
