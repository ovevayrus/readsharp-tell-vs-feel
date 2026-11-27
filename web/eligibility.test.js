import assert from 'node:assert/strict';
import test from 'node:test';
import { EUROPEAN_ZONES, isEligible, isExcludedTimeZone } from './eligibility.js';

const defaults = {
  navigator: {},
  location: { search: '' },
  timeZone: 'America/New_York',
};

test('global privacy control true excludes the visitor', () => {
  const navigator = { globalPrivacyControl: true };
  assert.equal(isEligible({ ...defaults, navigator }), false);
});

for (const globalPrivacyControl of [false, undefined]) {
  test(`global privacy control ${globalPrivacyControl} allows the visitor`, () => {
    assert.equal(isEligible({ ...defaults, navigator: { globalPrivacyControl } }), true);
  });
}

for (const search of ['?optout', '?optout=1', '?a=1&optout']) {
  test(`${search} excludes the visitor`, () => {
    assert.equal(isEligible({ ...defaults, location: { search } }), false);
  });
}

const namedEuropeanZones = [
  'Atlantic/Reykjavik',
  'Atlantic/Canary',
  'Atlantic/Madeira',
  'Atlantic/Azores',
  'Atlantic/Faroe',
  'Arctic/Longyearbyen',
  'Asia/Nicosia',
  'Asia/Famagusta',
  'Africa/Ceuta',
  'Indian/Reunion',
  'Indian/Mayotte',
  'America/Cayenne',
  'America/Guadeloupe',
  'America/Martinique',
  'America/Marigot',
];

test('the exported list contains the exact named exclusions and is frozen', () => {
  assert.deepEqual(EUROPEAN_ZONES, namedEuropeanZones);
  assert.equal(Object.isFrozen(EUROPEAN_ZONES), true);
});

for (const timeZone of [
  'UTC',
  'Etc/UTC',
  'Etc/GMT+5',
  'GMT',
  '',
  undefined,
  '   ',
  null,
  123,
  'Europe/Berlin',
  'Europe/London',
  ...namedEuropeanZones,
  'Atlantic/Faeroe',
  'Atlantic/Jan_Mayen',
  'Poland',
  'America/Unknown',
]) {
  test(`time zone ${JSON.stringify(timeZone)} excludes the visitor`, () => {
    assert.equal(isExcludedTimeZone(timeZone), true);
    assert.equal(isEligible({ ...defaults, timeZone }), false);
  });
}

for (const timeZone of [
  'America/New_York',
  'Asia/Kolkata',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Asia/Tokyo',
]) {
  test(`time zone ${timeZone} allows the visitor`, () => {
    assert.equal(isExcludedTimeZone(timeZone), false);
    assert.equal(isEligible({ ...defaults, timeZone }), true);
  });
}

test('a throwing time zone getter excludes the visitor', () => {
  assert.equal(isEligible({
    ...defaults,
    get timeZone() { throw new Error('Time zone unavailable'); },
  }), false);
});

test('Intl failure excludes the visitor when the time zone is omitted', (t) => {
  t.mock.method(Intl, 'DateTimeFormat', () => { throw new Error('Intl unavailable'); });
  assert.equal(isEligible({ navigator: defaults.navigator, location: defaults.location }), false);
});

test('omitting the time zone uses the browser time zone at call time', (t) => {
  const DateTimeFormat = Intl.DateTimeFormat;
  t.mock.method(Intl, 'DateTimeFormat', function (...args) {
    if (args.length === 0) return { resolvedOptions: () => ({ timeZone: 'Asia/Tokyo' }) };
    return new DateTimeFormat(...args);
  });
  assert.equal(isEligible({ navigator: defaults.navigator, location: defaults.location }), true);
});

test('missing navigator excludes the visitor', () => {
  assert.equal(isEligible({ ...defaults, navigator: undefined }), false);
});

test('non-string location search excludes the visitor', () => {
  assert.equal(isEligible({ ...defaults, location: { search: 1 } }), false);
});
