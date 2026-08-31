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
import { ResultCode, DeviceMode } from '../sdk/constants.js';
import { BpPlusDevice } from '../sdk/device/bpplus-device.js';
import { SimulatorTransport } from '../sdk/transports/simulator.js';

let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '   ' + detail : ''}`);
}

// ── Does every SDK module parse? ─────────────────────────────────────────────
// `node --check` does not parse a .js file as ESM, so it passes a module with a
// syntax error in it. A stray apostrophe in sdk/selftest.js reached the tablet
// that way and surfaced as "could not run: missing ) after argument list" when
// the operator pressed the self-test button. Importing each module is the only
// check that means anything.

console.log('\nSDK modules parse');

{
  const dir = new URL('../sdk/', import.meta.url);
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? walk(new URL(entry.name + '/', d))
      : (entry.name.endsWith('.js') ? [new URL(entry.name, d)] : []));

  const modules = walk(dir);
  let broken = 0;

  for (const url of modules) {
    try {
      await import(url);
    } catch (error) {
      // A module that needs a DOM is not a parse failure; a SyntaxError is.
      if (error instanceof SyntaxError) {
        broken++;
        console.log(`  FAIL  ${url.pathname.split('/sdk/')[1]} — ${error.message}`);
      }
    }
  }

  check(`all ${modules.length} SDK modules parse`, broken === 0);
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

  // ── Two blocks on one page ────────────────────────────────────────────────
  // The visit instrument puts seated and standing in separate blocks with
  // per-position ids. The module must bind each block's own controls; binding
  // by the bare id would give both blocks the seated one.
  const twoBlock = `<!doctype html><html><body>
    <button id="connect-bp-btn-seated"></button>
    <button id="start-seated-btn"></button>
    <button id="cancel-bp-btn-seated"></button>
    <button id="repeat-btn-seated"></button>
    <div id="status-display-seated"></div>
    <div id="alerts-display-seated"></div>
    <div id="visit-state-seated"></div>
    <div id="seated-results-panel"></div>
    <button id="connect-bp-btn-standing"></button>
    <button id="start-standing-btn"></button>
    <button id="cancel-bp-btn-standing"></button>
    <button id="repeat-btn-standing"></button>
    <div id="status-display-standing"></div>
    <div id="alerts-display-standing"></div>
    <div id="visit-state-standing"></div>
    <div id="standing-results-panel"></div>
    <input type="hidden" name="sys_standing_required" value="1">
  </body></html>`;

  const dom2 = new JSDOM(twoBlock, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.AOBP_CONFIG = { record: 'TEST-002', sdkUrl: 'about:blank' };
  const errors2 = [];
  w2.console.error = (...a) => errors2.push(a.map(String).join(' '));
  w2.console.log = () => {};
  w2.eval(fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8'));
  w2.document.dispatchEvent(new w2.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 150));

  const el2 = id => w2.document.getElementById(id);

  console.log('\ntwo blocks, per-position ids');
  check('the module starts', !!w2.AOBP);
  check('nothing reached console.error', errors2.length === 0, errors2.join(' | '));
  check('each block got its own status line',
    !!el2('status-display-seated').innerText && !!el2('status-display-standing').innerText);
  check('each block got its own visit state',
    !!el2('visit-state-seated').innerText && !!el2('visit-state-standing').innerText);
  check('both cancel buttons start disabled',
    el2('cancel-bp-btn-seated').disabled && el2('cancel-bp-btn-standing').disabled);
  check('both repeat buttons start disabled',
    el2('repeat-btn-seated').disabled && el2('repeat-btn-standing').disabled);
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

// ── A stale alert on a determination that succeeded ─────────────────────────
// The TM2917 retries up to three times and, when a later attempt works, records
// the good values while leaving the failed attempt's Alert in place. The same
// text therefore means different things depending on what the determination
// produced.

console.log('\nrecovered retries');

{
  const fault = 'Unable to measure BP: Over Pressure (C19);AA;';
  const good = alertsOf({ readings: [{ sys: 122, dia: 78, pr: 70, alert: fault }] }, range);
  const bad  = alertsOf({ readings: [{ sys: 0, dia: 0, pr: 0, alert: fault }] }, range);

  check('a fault on a determination that produced numbers is a warning',
    good[0]?.severity === 'caution', JSON.stringify(good[0]?.severity));
  check('and is marked as recovered', good[0]?.recovered === true);
  check('the same fault on one that produced nothing stays an error',
    bad[0]?.severity === 'bad');
  check('and is not marked as recovered', bad[0]?.recovered === false);

  // Both cases in one run: the worse one must win for the shared message.
  const mixed = alertsOf({ readings: [
    { sys: 122, dia: 78, pr: 70, alert: fault },
    { sys: 0, dia: 0, pr: 0, alert: fault },
  ] }, range);
  check('one determination failing makes the shared alert an error',
    mixed[0]?.severity === 'bad');
  check('and it names both determinations',
    mixed[0]?.readings.join(',') === '1,2');

  check('a quality word is never softened by a good reading',
    alertsOf({ readings: [{ sys: 122, dia: 78, pr: 70, alert: 'Invalid Signal;AA;' }] },
      range)[0]?.severity === 'bad');

  check('without a bpRange nothing is assumed recovered',
    alertsOf({ readings: [{ sys: 122, dia: 78, pr: 70, alert: fault }] }, null)[0]
      ?.severity === 'caution');
}

// ── A failed open must not keep the port ─────────────────────────────────────
// Opening a serial port is several steps. A failure after the port itself
// opened used to leave it held by the page with the transport marked
// disconnected, so close() did nothing and the next attempt met "The port is
// already open" from the browser — unrecoverable short of a reload.

console.log('\npartial open releases the port');

{
  const { Transport } = await import('../sdk/transports/transport.js');

  class HalfOpening extends Transport {
    constructor() { super('Test'); this.closed = 0; this.portHeld = false; }
    async _open() {
      this.portHeld = true;                 // the port is now ours
      throw new Error('could not take the reader');
    }
    async _close() { this.closed++; this.portHeld = false; }
    async _write() {}
  }

  const t = new HalfOpening();
  let threw = false;
  try { await t.open(); } catch { threw = true; }

  check('open() still reports the failure', threw);
  check('_close() ran, so the port was given back', t.closed === 1);
  check('nothing is still held', t.portHeld === false);
  check('and the transport reads as disconnected', t.state === 'disconnected');

  // A close that itself fails must not mask the original error.
  class Stubborn extends HalfOpening {
    async _close() { throw new Error('close failed too'); }
  }
  const s2 = new Stubborn();
  let message = '';
  try { await s2.open(); } catch (e) { message = e.message; }
  check('a failing close does not hide why the open failed',
    /could not take the reader/.test(message), message);
}

// ── A measurement started on the device is refused ───────────────────────────
// The BP+ has its own Start button. A measurement begun there carries no
// patient ID and belongs to no record, so a host that records against a
// participant has to stop it.

console.log('\nhost-started-only');

{
  const device = new BpPlusDevice(new SimulatorTransport(), { hostStartedOnly: true });
  await device.connect();

  const cancels = [];
  device.cancel = async () => { cancels.push(1); };

  const seen = [];
  device.on('deviceStarted', e => seen.push(e));

  const mode = code => device._handleMode({ code, name: 'm' + code });

  // Somebody walks the device into the AOBP menu and presses Start.
  mode(DeviceMode.selectAobpMode);
  check('the AOBP menu is noticed', seen.length === 1);
  check('but nothing is cancelled while they are still choosing',
    cancels.length === 0 && seen[0]?.cancelling === false);

  mode(DeviceMode.countDownAobp);
  check('the countdown is cancelled', cancels.length === 1);

  mode(DeviceMode.measuringBp);
  check('the modes that follow do not cancel again', cancels.length === 1);

  mode(DeviceMode.ready);
  mode(DeviceMode.countDownAobp);
  check('a second press is cancelled too', cancels.length === 2);

  // The host's own measurement must pass through untouched. measure() sets the
  // state before it sends `s`, so the same modes arrive with measuring set.
  device._setState('measuring');
  const before = cancels.length;
  mode(DeviceMode.countDownAobp);
  mode(DeviceMode.measuringBp);
  check("the host's own measurement is left alone", cancels.length === before);

  await device.disconnect();
}

{
  const device = new BpPlusDevice(new SimulatorTransport());
  await device.connect();
  const cancels = [];
  device.cancel = async () => { cancels.push(1); };
  device._handleMode({ code: DeviceMode.countDownAobp, name: 'm22' });
  check('off by default, so a monitoring tool does not interfere',
    cancels.length === 0);
  await device.disconnect();
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
