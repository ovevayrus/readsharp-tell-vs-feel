/** Exact European exclusions outside the Europe/ prefix. */
export const EUROPEAN_ZONES = Object.freeze([
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
]);

function isExcludedZoneName(zone) {
  return typeof zone !== 'string'
    || !zone.includes('/')
    || zone.startsWith('Etc/')
    || zone.startsWith('Europe/')
    || EUROPEAN_ZONES.includes(zone)
    || zone === 'Atlantic/Faeroe'
    || zone === 'Atlantic/Jan_Mayen';
}

/** Exclude European, legacy, and unknown time zones. */
export function isExcludedTimeZone(timeZone) {
  if (isExcludedZoneName(timeZone)) return true;

  try {
    const resolved = new Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions();
    return isExcludedZoneName(resolved.timeZone);
  } catch {
    return true;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Check eligibility using browser values unless explicit inputs are supplied. */
export function isEligible(options = {}) {
  try {
    if (!isObject(options)) return false;

    const navigator = 'navigator' in options ? options.navigator : globalThis.navigator;
    if (!isObject(navigator)) return false;
    const gpc = navigator.globalPrivacyControl;
    if (gpc !== false && gpc !== undefined) return false;

    const location = 'location' in options ? options.location : globalThis.location;
    if (!isObject(location)) return false;
    const search = location.search;
    if (typeof search !== 'string' || new URLSearchParams(search).has('optout')) return false;

    const timeZone = 'timeZone' in options
      ? options.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
    return !isExcludedTimeZone(timeZone);
  } catch {
    return false;
  }
}
