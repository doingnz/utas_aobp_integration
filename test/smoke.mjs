/**
 * Does js/aobp.js still start, and does the SDK still refuse a bad result?
 *
 *   npm install --no-save jsdom
 *   node test/smoke.mjs
 *
 * `node --check` only parses. It cannot see a value read before it was
 * assigned, which is how a build reached a tablet with the module dead on load
 * and nothing but the harness banner to say so. This loads the module against a
 * stand-in instrument, fires DOMContentLoaded, and fails if window.AOBP is
 * missing or anything reached console.error.
 *
 * The second half needs no DOM and always runs.
 */

import fs from 'node:fs';
import {
  unusableReason,
  parseAlerts,
  alertsOf,
  classifyAlert,
} from '../sdk/device/measurement.js';
import { ResultCode } from '../sdk/constants.js';

let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '   ' + detail : ''}`);
}

// ── Does the module initialise? ──────────────────────────────────────────────

async function loadJsdom() {
  try {
    return (await import('jsdom')).JSDOM;
  } catch {
    return null;
  }
}

const JSDOM = await loadJsdom();

if (!JSDOM) {
  console.log('\nmodule start-up: SKIPPED — needs jsdom');
  console.log('  npm install --no-save jsdom');
} else {
  console.log('\nmodule start-up');

  // Every element aobp.js looks for, and nothing else.
  const html = `<!doctype html><html><body>
    <div id="status-display"></div>
    <button id="connect-bp-btn"></button>
    <button id="start-seated-btn"></button>
    <button id="start-standing-btn"></button>
    <button id="cancel-bp-btn"></button>
    <button id="ping-bp-btn"></button>
    <button id="set-aobp-mode-btn"></button>
    <div id="visit-state"></div>
    <div id="alerts-display"></div>
    <div id="seated-results-panel"></div>
    <div id="standing-results-panel"></div>
    <input type="hidden" name="sys_standing_required" value="0">
    <input type="hidden" name="sys_measurement_status" value="">
  </body></html>`;

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.AOBP_CONFIG = { record: 'TEST-001', sdkUrl: 'about:blank' };

  const errors = [];
  w.console.error = (...args) => errors.push(args.map(String).join(' '));
  w.console.log = () => {};

  w.eval(fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(resolve => setTimeout(resolve, 150));

  const el = id => w.document.getElementById(id);

  check('window.AOBP is set', !!w.AOBP);
  check('nothing reached console.error', errors.length === 0, errors.join(' | '));
  check('the status line was rendered', !!el('status-display').innerText);
  check('the visit state was rendered', !!el('visit-state').innerText);
  check('every control starts disabled',
    ['start-seated-btn', 'start-standing-btn', 'cancel-bp-btn', 'ping-bp-btn',
     'set-aobp-mode-btn'].every(id => el(id).disabled === true));
}

// ── Is a result a reading? ───────────────────────────────────────────────────
// The ranges are a real device's, from the feature list of the BP+ these were
// written against.

console.log('\nresult validation');

const range = {
  sys: { max: 280, min: 40 },
  dia: { max: 200, min: 20 },
  map: { max: 245, min: 25 },
  hr:  { max: 240, min: 30 },
};
const result = (sys, dia, pr = 70) => ({ brachial: { sys, dia, pr } });
const codeOf = (...args) => (unusableReason(...args) || {}).code ?? null;

check('a real reading is usable', codeOf(result(122, 78), range) === null);
check('a reading at the declared limits is usable', codeOf(result(280, 21, 240), range) === null);
check('no pressure at all is refused',
  codeOf(result(null, null), range) === ResultCode.measurementDataInvalid);
check('the zeros an aborted run returns are refused',
  codeOf(result(0, 0, 0), range) === ResultCode.measurementBPOutOfRange);
check('below the device minimum is refused',
  codeOf(result(35, 20), range) === ResultCode.measurementBPOutOfRange);
check('above the device maximum is refused',
  codeOf(result(300, 90), range) === ResultCode.measurementBPOutOfRange);
check('an absurd heart rate is refused',
  codeOf(result(120, 80, 500), range) === ResultCode.measurementBPOutOfRange);
check('systolic not above diastolic is refused',
  codeOf(result(100, 100), range) === ResultCode.measurementDataInvalid);
check('without a feature list a plausible reading is still usable',
  codeOf(result(122, 78), null) === null);
check('without a feature list an empty result is still refused',
  codeOf(result(null, null), null) === ResultCode.measurementDataInvalid);

// ── Alert parsing ────────────────────────────────────────────────────────────
// Firmware packs <Alert> as message;hex; pairs. The hex is the module's raw
// reply and must never reach a clinical user, so the two halves come back
// separately rather than run together in one string.

console.log('\nalert parsing');

const oneAlert = 'Unable to measure BP: Over Pressure (C19);1B0B6843313930412004CB;';
const parsed = parseAlerts(oneAlert);

check('one alert yields one entry', parsed.length === 1);
check('the message excludes the hex',
  parsed[0]?.message === 'Unable to measure BP: Over Pressure (C19)',
  JSON.stringify(parsed[0]?.message));
check('the hex is kept separately',
  parsed[0]?.tm2917_hex_result === '1B0B6843313930412004CB');

const two = parseAlerts('Over Pressure (C19);AABB;Air Leak (C07);CCDD;');
check('two alerts yield two entries', two.length === 2);
check('the second message is intact', two[1]?.message === 'Air Leak (C07)');

check('a message with no hex still parses',
  parseAlerts('Something odd')[0]?.tm2917_hex_result === null);
check('an empty element yields nothing', parseAlerts('').length === 0);
check('a trailing separator adds no empty entry',
  parseAlerts('Only one;AABB;').length === 1);

check('the same alert on every reading is reported once',
  alertsOf({ readings: [{ alert: oneAlert }, { alert: oneAlert }] }).length === 1);
check('a result with no readings and no Alert yields nothing',
  alertsOf({ brachial: { sys: 0, dia: 0 } }).length === 0);

// ── Quality alerts are not faults ────────────────────────────────────────────
// The device reports signal quality through the same <Alert> element it uses
// for faults. Treating every alert as a problem puts a warning on a perfect
// measurement.

console.log('\nalert severity');

const sev = m => classifyAlert(m).severity;

check('Excellent is good news', sev('Excellent Signal') === 'good');
check('Good is good news', sev('Good Signal') === 'good');
check('Acceptable is good news', sev('Acceptable Signal') === 'good');
check('Poor asks for attention', sev('Poor Signal') === 'caution');
check('Invalid is bad', sev('Invalid Signal') === 'bad');
check('a fault is bad', sev('Unable to measure BP: Over Pressure (C19)') === 'bad');
check('an unrecognised alert is shown, not softened', sev('Something new') === 'bad');
check('matching is case insensitive', sev('excellent signal') === 'good');
check('a word that merely starts with a label is not a quality report',
  sev('Goodness gracious') === 'bad');
check('the quality label is reported', classifyAlert('Poor Signal').quality === 'Poor');
check('a fault has no quality label',
  classifyAlert('Unable to measure BP: Over Pressure (C19)').quality === null);
check('severity rides along on a parsed alert',
  parseAlerts('Excellent Signal;AABB;')[0]?.severity === 'good');

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
