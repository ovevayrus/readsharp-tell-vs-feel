import { isEligible } from '../eligibility.js';
import { createExperiment } from '../experiment.js';
import { createFeelReader } from '../feel-reader.js';
import { engine, practicePace } from './stand-in-engine.js';

const PLACEHOLDER = '__FS_DEV_CLIENT_KEY__';
const SAMPLE = { speedWpm: 250, correct: 3, total: 3 };
// Original demo text, about 50 words.
const DEMO_TEXT = 'The lighthouse keeper climbed the narrow stairs every evening, lantern swinging at his side. '
  + 'Halfway up he always paused to listen: waves below, gulls above, and the wind humming through the old iron rails. '
  + 'Then he lit the lamp, and the beam swept slowly across the dark water, steady as a heartbeat.';

const $ = (id) => document.getElementById(id);
const key = document.body.dataset.fsKey;

let eligible = null;
let identity = null;
const experiment = createExperiment({
  sdk: () => import('/vendor/flagsmith.mjs').then((m) => m.default),
  environmentID: key === PLACEHOLDER ? '' : key,
  isEligible: () => {
    eligible = isEligible();
    return eligible;
  },
  randomUUID: () => {
    identity = crypto.randomUUID();
    return identity;
  },
});

function renderDebug(arm, exposed) {
  $('d-eligible').textContent = eligible === null ? 'not checked' : eligible ? 'yes' : 'no';
  $('d-arm').textContent = arm ?? '-';
  $('d-identity').textContent = identity ?? 'none (nothing set up)';
  $('d-exposed').textContent = exposed === undefined ? '-' : exposed ? 'yes' : 'no';
}

$('start').addEventListener('click', () => {
  $('start').disabled = true;
  experiment.start();
  if (eligible === null) eligible = isEligible();
  renderDebug();
  $('show').disabled = false;
});

$('show').addEventListener('click', async () => {
  $('show').disabled = true;
  const pace = practicePace(SAMPLE.speedWpm);
  let shownArm = null;
  const outcome = await experiment.result((arm) => {
    shownArm = arm;
    $('measured').textContent = `You read at ${SAMPLE.speedWpm} words per minute, ${SAMPLE.correct} of ${SAMPLE.total} correct.`;
    $('practice').textContent = `Try practising at ${pace} words per minute (STAND-IN pace).`;
    $('card-text').textContent = `${SAMPLE.speedWpm} wpm, ${SAMPLE.correct} of ${SAMPLE.total} correct`;
    $('result').hidden = false;
    $('ineligible').hidden = eligible === true;
    const reader = $('reader');
    reader.hidden = arm !== 'feel';
    if (arm === 'feel') {
      createFeelReader({ root: reader, text: DEMO_TEXT, wpm: pace, measuredWpm: SAMPLE.speedWpm, engine });
    }
    renderDebug(arm, false);
  });
  renderDebug(shownArm ?? outcome.arm, outcome.exposed);
});

async function sendEvent(name, label = '') {
  const sent = await experiment.track(name);
  $('note').textContent = sent ? `Event sent: ${name}${label}` : `No event sent (${name}): this view was not exposed.`;
}

$('get').addEventListener('click', () => sendEvent('get_readsharp'));

$('share').addEventListener('click', async () => {
  const line = `I read at ${SAMPLE.speedWpm} words per minute, ${SAMPLE.correct} of ${SAMPLE.total} correct (demo).`;
  try {
    await navigator.clipboard.writeText(line);
  } catch {
    $('note').textContent = 'Could not copy to the clipboard, so no event was sent.';
    return;
  }
  await sendEvent('result_shared', ' (copied)');
});
