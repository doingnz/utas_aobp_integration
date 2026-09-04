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
import crypto from 'node:crypto';
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

// -- Is sdk/ still the copy it says it is? ------------------------------------
// sdk/ is a vendored copy of Uscom/bpplus-js-sdk, pinned by sdk/SDK-VERSION.json.
// An edit made here and nowhere else is lost at the next sync and invisible
// until then. A version number records only what nobody changed, so this checks
// a hash of the folder: two copies can report the same SDK_VERSION and differ.
//
// The algorithm matches Get-SdkHash in bpplus-redcap's tools/sync-sdk.ps1, which
// is what writes the file: every .js under sdk/ sorted by path with an ordinal
// comparison, each hashed as UTF-8 with CRLF normalised to LF, joined as
// "path hash" lines separated by LF, and the whole hashed again.

console.log('\nvendored SDK');

{
  const sdkTreeHash = dir => {
    const sha = data => crypto.createHash('sha256').update(data).digest('hex');
    const walk = (d, prefix = '') => fs.readdirSync(d, { withFileTypes: true })
      .flatMap(e => e.isDirectory()
        ? walk(new URL(e.name + '/', d), prefix + e.name + '/')
        : (e.name.endsWith('.js') ? [[prefix + e.name, new URL(e.name, d)]] : []));

    const lines = walk(dir)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, url]) => {
        const text = fs.readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
        return name + ' ' + sha(Buffer.from(text, 'utf8')) + '\n';
      })
      .join('');

    return sha(Buffer.from(lines, 'utf8'));
  };

  const file = new URL('../sdk/SDK-VERSION.json', import.meta.url);

  if (!fs.existsSync(file)) {
    check('sdk/SDK-VERSION.json is present', false,
      'the vendored copy cannot be traced to an upstream release');
  } else {
    const declared = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { SDK_VERSION } = await import('../sdk/index.js');
    const actual = sdkTreeHash(new URL('../sdk/', import.meta.url));

    check('SDK-VERSION.json matches the SDK it describes',
      declared.sdkVersion === SDK_VERSION,
      'declared ' + declared.sdkVersion + ', code says ' + SDK_VERSION);

    check('sdk/ has not been edited in place',
      actual === declared.vendored?.treeSha256,
      'recorded ' + declared.vendored?.treeSha256 + ', actual ' + actual +
      ' -- change it upstream in Uscom/bpplus-js-sdk and re-vendor, not here');

    console.log('        SDK ' + declared.sdkVersion + ' at ' + declared.source?.ref);
  }
}

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
    <button id="ping-bp-btn"></button>
    <button id="set-aobp-mode-btn"></button>
    <div id="visit-state"></div>
    <div id="alerts-display"></div>
    <div id="seated-results-panel"></div>
    <div id="standing-results-panel"></div>
    <input type="hidden" name="sys_standing_required" value="0">
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
    ['start-seated-btn', 'start-standing-btn', 'ping-bp-btn',
     'set-aobp-mode-btn'].every(id => el(id).disabled === true));

  // One block means both positions resolve to the same Connect button. Wiring
  // per position put two listeners on it, so one press opened the port picker
  // and then immediately failed the second attempt with "No port selected by
  // the user" — over the top of the picker the operator was still looking at.
  errors.length = 0;
  el('connect-bp-btn').dispatchEvent(new w.Event('click'));
  await new Promise(resolve => setTimeout(resolve, 200));

  check('a shared Connect button runs its handler once, not once per position',
    errors.length <= 1, errors.length + ' attempts: ' + errors.join(' | '));

  // ── Two blocks on one page ────────────────────────────────────────────────
  // The visit instrument puts seated and standing in separate blocks with
  // per-position ids. The module must bind each block's own controls; binding
  // by the bare id would give both blocks the seated one.
  const twoBlock = `<!doctype html><html><body>
    <button id="connect-bp-btn-seated"></button>
    <button id="start-seated-btn">Start seated</button>
    <div id="status-display-seated"></div>
    <div id="alerts-display-seated"></div>
    <div id="visit-state-seated"></div>
    <div id="seated-results-panel"></div>
    <button id="connect-bp-btn-standing"></button>
    <button id="start-standing-btn">Start standing</button>
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
  // One control per position, saying what pressing it will do. A separate
  // Repeat button sat beside Start running the identical call, which gave the
  // operator two ways to do one thing and no way to tell them apart.
  check('Start says Start before there is anything to repeat',
    el2('start-seated-btn').textContent.trim() === 'Start seated');

  // Start, Repeat and Cancel were three controls for one measurement, two of
  // them disabled at any moment and Cancel disabled for all but the ninety
  // seconds it was wanted. One button now says what pressing it will do.
  const app2 = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');
  check('there is no cancel button left to look for',
    !app2.includes('cancel-bp-btn'));
  check('the Start button cancels while a measurement is running',
    /function startOrCancel/.test(app2) &&
    /if \(busy && currentMode === mode\) \{/.test(app2));
  check('and says Cancel while it does',
    /replace\(.{0,12}Start.{0,4}, 'Cancel'\)/.test(app2));
  check('so it stays live for the position being measured',
    /ready \|\| stopping\('seated'\)/.test(app2));
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

  // What the operator sees, as opposed to what the record keeps. The TM2917
  // retries a determination it could not measure and still reports the attempt
  // it threw away, so a measurement that finished cleanly carried "Unable to
  // measure BP: Please Repeat (C13)" in red over a good reading. There is no
  // finish code, nothing went wrong, and nothing for the operator to do.
  const app = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');

  check('a measurement with no F nn shows only its quality line',
    /succeeded && cfg\.detailedWarnings !== true/.test(app));
  check('and the detail can still be turned back on',
    app.includes('detailedWarnings'));

  // The default has to hold everywhere it is set, not just in the module. Both
  // harnesses and the REDCap module were passing detailedWarnings: true, so the
  // module's own default never applied and the warnings kept appearing.
  const php  = fs.readFileSync(new URL('../AobpIntegration.php', import.meta.url), 'utf8');
  const one  = fs.readFileSync(new URL('harness.html', import.meta.url), 'utf8');
  const two  = fs.readFileSync(new URL('harness-visit.html', import.meta.url), 'utf8');

  check('nothing turns detailed warnings on behind the operator',
    !php.includes("? false : true") &&
    /aobp-show-recovered-warnings/.test(php) &&
    !one.includes('detailedWarnings: true') &&
    !two.includes('detailedWarnings: true'));

  // The filter decides what is displayed, never what is recorded: every alert
  // still reaches the console, or the evidence for a device fault disappears
  // with the warning that would have prompted someone to look.
  const logAt    = app.indexOf('[AOBP] device alert (');
  const filterAt = app.indexOf('cfg.detailedWarnings !== true');
  check('every alert is still logged, whatever is shown',
    logAt > 0 && logAt < filterAt);
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

// ── Teardown must not hang ───────────────────────────────────────────────────
// The port is opened with hardware flow control. With a cable in the PC but not
// in a BP+, nothing asserts CTS, pending writes never drain, and a writer
// close() waits for ever — which froze a connect that had already timed out,
// leaving every button disabled and no error on screen.

console.log('\nteardown is deadlined');

{
  const src = fs.readFileSync(new URL('../sdk/transports/web-serial.js', import.meta.url), 'utf8');

  check('the writer is aborted, not closed',
    /_writer\.abort\(\)/.test(src) && !/await this\._writer\.close\(\)/.test(src));
  check('every teardown step is deadlined',
    (src.match(/await settle\(/g) || []).length >= 3);

  // The helper itself is exercised in its own block below, which pulls it out
  // of the source rather than restating it here.

  // Ordering matters: cancel() only makes the pending read() resolve, so the
  // loop is still running when releaseLock() would be called.
  const cancelAt = src.indexOf('this._reader.cancel()');
  const loopAt   = src.indexOf('settle(this._readLoop');
  const freeAt   = src.indexOf('this._reader.releaseLock()');
  check('the read loop is awaited between cancel and releaseLock',
    cancelAt > 0 && loopAt > cancelAt && freeAt > loopAt);

  check('a port that will not close is reported, not swallowed',
    /did not close/.test(src));
  check('an already-open port is closed and reopened rather than refused',
    /already open/i.test(src) && /await this\._port\.open\(settings\);/.test(src));

  // forget() revokes the permission, so the device returns as a new SerialPort
  // object while the old one still holds the operating system handle. The retry
  // then meets "Failed to open serial port" — which no retry can clear — and
  // the operator is sent back to the picker for a port they already granted.
  check('the recovery never forgets the port',
    !/\.forget\s*\(/.test(src));

  // Cheaper than waiting to be refused: readable and writable are non-null only
  // while the port is open, and a port this page holds open is ours to close.
  const heldAt = src.indexOf('this._port.readable || this._port.writable');
  const openAt = src.indexOf('await this._port.open(settings)');
  check('a port this page still holds is closed before it is reopened',
    heldAt > 0 && heldAt < openAt);
}

// ── A port that opened but did not answer is kept ────────────────────────
// The cable not being in the BP+ says nothing about the port, which opened
// perfectly. Closing it to try again costs the operator the browser's picker,
// and asks close() to drain a write that hardware flow control will not let go.

console.log('\nan unanswered port is retried, not reopened');

{
  const app = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');
  const trans = fs.readFileSync(new URL('../sdk/transports/web-serial.js', import.meta.url), 'utf8');

  check('the capability check no longer tears the port down',
    !/device\.disconnect\(\)\.catch/.test(app));
  check('verification is separable from opening',
    /async function verify\(\)/.test(app) && /await verify\(\);/.test(app));
  check('a second press retries rather than reopening',
    /if \(retrying\) await verify\(\);/.test(app));

  // Otherwise the operator gets live Start buttons for a port with nothing
  // proven on the end of it.
  check('an unverified device does not arm the Start buttons',
    /var linked = !!device && !!features && !busy;/.test(app));

  // Suprasystolic mode measures something else entirely. A reading taken in it
  // lands in seated_ave_sys looking exactly like a protocol one.
  check('and neither does a device in the wrong mode',
    /var ready = linked && deviceIsAobp\(\);/.test(app));
  check('but Set AOBP mode stays live, or there is no way out',
    /setEnabled\(ui\.setAobp,  linked && canSetAobpMode\(\)\)/.test(app));

  // A cable pulled out of the computer kills the port. Retrying on it for ever
  // would be the cost of keeping it.
  check('an unplugged cable invalidates the port',
    /addEventListener\('disconnect'/.test(trans) &&
    /removeEventListener\('disconnect'/.test(trans));
  check('and the page then falls back to a fresh port',
    /if \(device && !device\.transport\.isConnected\) device = null;/.test(app));
}

// -- Who cancelled it ------------------------------------------------------
// F 02 comes back whether the host sent `c` or somebody pressed the button on
// the device. Telling an operator who has just pressed Cancel that the
// measurement was cancelled at the device is simply untrue.

console.log('\na cancel says who asked for it');

{
  const { ErrorReason } = await import('../sdk/core/errors.js');
  const src = fs.readFileSync(
    new URL('../sdk/device/bpplus-device.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');

  check('the SDK has a name for a host-sent cancel',
    ErrorReason.cancelledByHost === 'cancelledByHost');
  check('cancel() records that it was asked',
    /this\._cancelRequested = true;/.test(src));
  check('and each measurement starts without one remembered',
    /this\._cancelRequested = false;/.test(src));
  check('the tag reaches the error the measurement rejects with',
    /ErrorReason\.cancelledByHost/.test(src));
  check('the page words it by who did it',
    /cancelledByHost/.test(app) && /stopped at the BP\+/.test(app));
}

// Driven, not read. The source check above passed while the behaviour was
// wrong: a cancel during the countdown produces F 02 with no result block, so
// the session rejects the request itself and never reaches the branch that was
// carrying the tag. Only running one shows that.
{
  const { ErrorReason } = await import('../sdk/core/errors.js');

  const device = new BpPlusDevice(new SimulatorTransport({ tickMs: 5 }));
  await device.connect();

  const measuring = device.measure({ patientId: 'CANCEL-1' });
  await new Promise(resolve => setTimeout(resolve, 40));
  await device.cancel();

  // Bounded, because an unbounded await turns a cancel that never arrives into
  // a suite that never finishes — seen roughly one run in three, stopping dead
  // here with every earlier check passed and no failure reported. A hanging
  // test says less than a failing one.
  const settled = promise => Promise.race([
    promise.then(() => null).catch(error => error),
    new Promise(resolve => setTimeout(() => resolve('TIMED OUT'), 10000)),
  ]);

  const hostCancel = await settled(measuring);

  check('a cancel the host sent is tagged as the host asking',
    hostCancel?.code === ResultCode.cancelled &&
    hostCancel?.reason === ErrorReason.cancelledByHost,
    String(hostCancel?.code ?? hostCancel) + ' reason=' + String(hostCancel?.reason));

  // The device's own stop must NOT be tagged, or the wording is wrong the
  // other way round.
  const second = new BpPlusDevice(new SimulatorTransport({ tickMs: 5 }));
  await second.connect();
  const running = second.measure({ patientId: 'CANCEL-2' });
  await new Promise(resolve => setTimeout(resolve, 40));
  // The same bytes device.cancel() would send, without going through it — this
  // is the operator reaching for the button, not the host asking.
  await second._session.sendImmediate('c' + String.fromCharCode(13, 10));

  const deviceCancel = await settled(running);

  check('a stop that the host did not ask for is not tagged',
    deviceCancel?.code === ResultCode.cancelled &&
    deviceCancel?.reason === undefined,
    String(deviceCancel?.code ?? deviceCancel) + ' reason=' + String(deviceCancel?.reason));
}

// -- Picking the device back up after a page change ------------------------
// A survey is several pages. The submit carrying the seated measurement ends
// the JavaScript holding the port, so the standing page started with nothing
// connected and asked the operator to connect again — participant stood up,
// waiting, while somebody found the right port in a picker for the second time.
// The browser's permission outlives the page even though the connection does
// not.

console.log('\na granted port is picked up without asking');

{
  const { WebSerialTransport } = await import('../sdk/transports/web-serial.js');

  const stub = count => {
    const ports = Array.from({ length: count }, () => ({
      readable: null, writable: null,
      getInfo: () => ({ usbVendorId: 0x067B }),
      async open() {
        this.opened = true;
        this.readable = { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {}, releaseLock() {} }) };
        this.writable = { getWriter: () => ({ write: async () => {}, abort: async () => {}, releaseLock() {} }) };
      },
      async close() { this.opened = false; },
      addEventListener() {}, removeEventListener() {},
    }));
    let pickerShown = false;
    Object.defineProperty(globalThis, 'navigator', {
      value: { serial: {
        getPorts: async () => ports,
        requestPort: async () => { pickerShown = true; throw new Error('picker'); },
        addEventListener() {}, removeEventListener() {},
      } },
      configurable: true, writable: true,
    });
    return { ports, shown: () => pickerShown };
  };

  const open = async count => {
    const s = stub(count);
    const t = new WebSerialTransport({ silent: true });
    try {
      await t.open();
      await t.close();
      return { ok: true, picker: s.shown(), opened: s.ports.filter(p => p.opened !== undefined).length };
    } catch (e) {
      return { ok: false, picker: s.shown(), message: e.message };
    }
  };

  const one = await open(1);
  check('one granted port opens with no picker', one.ok && !one.picker,
    JSON.stringify(one));

  // Nothing granted is the ordinary first visit, and the Connect button is
  // already on screen saying what to do.
  const none = await open(0);
  check('nothing granted is refused rather than prompted',
    !none.ok && !none.picker && /has been granted/.test(none.message));

  // Which of two is the BP+ is not knowable from here. That is what the picker
  // is for, and silently opening the wrong one would be worse than asking.
  const two = await open(2);
  check('more than one is left to the operator',
    !two.ok && !two.picker && /more than one/.test(two.message));

  // The page tries it on every load, and says nothing when there is nothing to
  // resume — the first page of a survey is exactly that case.
  const app = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');
  check('the page attempts a resume on load',
    /function resumeConnection/.test(app) && /connect\(\{ silent: true \}\)/.test(app));
  check('and a failed resume is quiet, leaving Connect where it was',
    /nothing to resume/.test(app));

  // A harness whose transport hook drops the flag sends the resume to the
  // picker, the browser refuses it without a user gesture, and the feature
  // looks broken on the bench while working in REDCap. Both harnesses build
  // transports themselves, so both have to pass it on.
  for (const page of ['harness.html', 'harness-visit.html']) {
    const html = fs.readFileSync(new URL(page, import.meta.url), 'utf8');
    const hook = html.slice(html.indexOf('AOBP_TRANSPORT = function'));
    const body = hook.slice(0, hook.indexOf('};'));
    const dropped = body.split(String.fromCharCode(10)).filter(line =>
      line.includes('new api.') && !line.includes('Simulator') && !line.includes('silent'));
    check(page + ' passes silent to every transport it builds',
      /function \(api, options\)/.test(body) && dropped.length === 0,
      dropped.join(' | '));
  }

  // Driven, because the checks above passed while the resume was still reaching
  // the picker: `silent` was threaded into makeTransport and not into the
  // constructor it calls, so the browser refused with "Must be handling a user
  // gesture to show a permission request" on every standing page.
  if (JSDOM) {
    const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const ports = [{
      readable: null, writable: null,
      getInfo: () => ({ usbVendorId: 0x067B }),
      async open() {
        this.opened = true;
        this.readable = { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {}, releaseLock() {} }) };
        this.writable = { getWriter: () => ({ write: async () => {}, abort: async () => {}, releaseLock() {} }) };
      },
      async close() { this.opened = false; },
      addEventListener() {}, removeEventListener() {},
    }];
    let picker = false;
    const fake = {
      serial: {
        getPorts: async () => ports,
        requestPort: async () => { picker = true; throw new Error('picker'); },
        addEventListener() {}, removeEventListener() {},
      },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151',
      maxTouchPoints: 0,
    };
    // The SDK is loaded by Node and reads the global navigator; the module runs
    // in jsdom and reads the window's. Both have to be the stub.
    Object.defineProperty(globalThis, 'navigator', { value: fake, configurable: true, writable: true });

    const rw = new JSDOM(`<!doctype html><html><body>
      <button id="connect-bp-btn-seated"></button><button id="start-seated-btn"></button>
      <div id="status-display-seated"></div><div id="visit-state-seated"></div>
      <div id="seated-results-panel"></div>
      <input type="hidden" name="sys_standing_required" value="0">
    </body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true }).window;
    Object.defineProperty(rw, 'navigator', { value: fake, configurable: true });
    rw.AOBP_CONFIG = { record: 'R1', sdkUrl: new URL('../sdk/index.js', import.meta.url).href };
    rw.console.log = () => {}; rw.console.warn = () => {}; rw.console.error = () => {};

    rw.eval(app);
    rw.document.dispatchEvent(new rw.Event('DOMContentLoaded'));
    await new Promise(r => setTimeout(r, 700));

    check('a real page load opens the granted port and never reaches the picker',
      ports[0].opened === true && picker === false,
      'opened=' + ports[0].opened + ' picker=' + picker);

    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  }
}

// -- The recording is filed at once, and the form is told which document ---
// A REDCap form posts the value its File Upload field was RENDERED with, so a
// page that rendered before the recording existed posts that emptiness back
// over it -- and an emptied file field is how REDCap deletes an edoc. The reply
// therefore carries the document id, and the page writes it into the form, so
// the submit posts back what is already stored and changes nothing. That is
// what REDCap's own upload dialog does with the id it gets.

console.log('\nrecordings are filed at once, and the form is told');

{
  const php = fs.readFileSync(new URL('../AobpIntegration.php', import.meta.url), 'utf8');
  const js  = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');

  const ajax = php.slice(php.indexOf('public function redcap_module_ajax'),
                         php.indexOf('private function tempDir'));

  check('the ajax call files the recording itself',
    /REDCap::storeFile\(/.test(ajax) && /REDCap::addFileToField\(/.test(ajax));

  check('and answers with the document id',
    /'status'   => 'saved'/.test(ajax) && /'doc_id'/.test(ajax));

  // Nothing waits anywhere any more: no stash, no second hook, and no window in
  // which the cleanup cron could take a recording nobody had saved yet.
  check('nothing is held on disk between requests',
    !/stashPath/.test(php) && !/aobp_pending_/.test(php));
  check('and there is no save hook left to file it later',
    !/redcap_save_record/.test(php) && !/fileHeldRecording/.test(php));

  // The temporary file exists only for the length of one request, because
  // storeFile() takes a path rather than bytes.
  check('the temporary file is removed in the same request',
    /tempnam\(/.test(ajax) && /@unlink\(\$tmp\)/.test(ajax));

  // This is the whole of the design in one line of JavaScript. Lose it and
  // every recording is filed correctly and then deleted by the next submit,
  // with nothing anywhere saying so.
  check('the page adopts the document id into the form',
    /adoptDocId\(/.test(js));

  // As an input. The hidden input carries the field name and no id, and the
  // download link beside it carries the same NAME.
  check('and selects the hidden input as an input, not by name alone',
    /input\[type="hidden"\]\[name="/.test(js));

  check('the save controls are shut while anything is in flight',
    /setSubmitEnabled\(/.test(js) && /submit-btn/.test(js));

  // Every reading field on this instrument is @READONLY, so a read-only test
  // that looked at the fields would refuse to measure on every page.
  check('a locked page is judged by its save controls, not its fields',
    /function readOnlyReason/.test(js) && /submit-btn/.test(js) &&
    !/\.readOnly/.test(js));

  // Both positions, and only this instrument.
  check('both positions have their own field',
    /'standing_raw_xml' : 'seated_raw_xml'/.test(php));
}

// -- Is a standing measurement required? ----------------------------------
// sys_standing_required is a calc field with @HIDDEN, and REDCap renders
// neither on a survey page. The module found no input, read it as empty, and
// closed the visit after the seated measurement — a participant who needed
// standing would have gone home without it. Seen in Oliver's console log as
// "no field named sys_standing_required on this page".

console.log('\nwhether standing is required has two sources');

{
  const app = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');
  const php = fs.readFileSync(new URL('../AobpIntegration.php', import.meta.url), 'utf8');

  // The field first: it is live, so dizz or faint answered on this page counts
  // immediately, where the server's stored calc would still be the old one.
  const fieldAt  = app.indexOf("document.querySelector('[name=\"' + FIELD_NAMES.standing_required");
  const configAt = app.indexOf('(window.AOBP_CONFIG || {}).standingRequired');
  check('the page prefers a live field over the server value',
    fieldAt > 0 && configAt > fieldAt);

  check('and the server supplies one for when there is no field',
    /'standingRequired' =>/.test(php) && /storedStandingRequired/.test(php));

  // "Not required" and "not known" are different answers. Defaulting the second
  // to the first is what ended the visit early in the first place.
  check('not knowing is reported, not assumed',
    /cannot tell whether a standing measurement is/.test(app));
  check('and said once, not on every button repaint',
    /standingUnknownSaid/.test(app));

  // Null rather than '' when the server cannot read it, for the same reason.
  // The reader is shared with the file fields now, so the distinction lives in
  // storedValue() rather than in the standing-required wrapper.
  const reader = php.slice(php.indexOf('private function storedValue'));
  check('the server distinguishes unknown from empty',
    /return \(\$value === null \|\| \$value === ''\) \? null :/.test(reader));
}

// -- A simulated device, and how a record says so -------------------------
// So the survey, the upload and the record can be tested where there is no BP+
// and no cable, which is most of what needs testing. Everything downstream runs
// exactly as it does for real — the point, and the danger.

console.log('\na simulated device is declared, on screen and in the record');

{
  const app = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');
  const php = fs.readFileSync(new URL('../AobpIntegration.php', import.meta.url), 'utf8');
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const setting = cfg['project-settings'].find(s => s.key === 'aobp-simulator');

  check('there is a project setting for it', !!setting);
  check('and it says what it is, in the setting name itself',
    !!setting && /TESTING ONLY/.test(setting.name) && /fabricated/.test(setting.name));
  check('the module passes it to the page',
    /'simulator'\s*=>\s*\(bool\)/.test(php));
  check('and the page uses the simulator transport when it is set',
    /if \(\(window\.AOBP_CONFIG \|\| \{\}\)\.simulator\) \{/.test(app) &&
    /new api\.SimulatorTransport\(\{/.test(app));

  // The status line is rewritten by every step of every measurement, so a
  // warning there is gone the moment anything happens.
  check('the warning is its own element, not the status line',
    /function showSimulatorBanner/.test(app) && /aobp-simulator-banner/.test(app));

  // The simulator answers with a plausible device id. A fabricated reading that
  // looks like every other reading is the one thing this must not produce —
  // whoever reads the export later was not in the room.
  const sim = fs.readFileSync(new URL('../sdk/transports/simulator.js', import.meta.url), 'utf8');
  check('the simulator does report a plausible device id',
    /DEVICE_ID = '015D90DE1A0000DA'/.test(sim));
  check('so the record is written with a marked one',
    /'SIMULATED-' \+ measurement\.deviceId/.test(app));

  // Both simulator options are load-bearing, and both defaults are wrong here.
  // tickMs defaults to 400, which makes a seated AOBP take as long as a seated
  // AOBP — nobody testing a file upload should wait out a rest period to reach
  // it.
  check('the simulator is told to run fast', /tickMs: 2,/.test(app));

  // measureMode defaults to plain BP+, and a BP+ that is not in AOBP mode has
  // Start disabled by design. Correct for a real device; a dead end for a
  // simulated one, and the operator would have had no way forward.
  check('and to be in AOBP mode, or Start stays refused',
    /measureMode: api\.MeasureMode\.bpPlusAobp,/.test(app));
}

// -- The XML, cut down to something a text field can hold -----------------
// Only for a project with file storage off. A REDCap text field holds 65,535
// bytes and an AOBP result is twice that, so the choice is between stripped and
// truncated — and a document cut off mid-element is worth nothing.

console.log('\nthe XML reduces to what cannot be recomputed');

{
  const { minimalXml } = await import('../sdk/device/measurement.js');

  // The SDK parses with the DOM the page gives it. Node has none, so minimalXml
  // hands the input straight back — correct behaviour, and it would pass every
  // check below by doing nothing. jsdom supplies the real thing.
  if (JSDOM) {
    const w = new JSDOM('').window;
    globalThis.DOMParser = w.DOMParser;
    globalThis.XMLSerializer = w.XMLSerializer;
  }

  // A stand-in with the same shape as a real result: the bulk elements around
  // the parts that have to survive.
  const xml =
    '<BPplus version="7.0"><MeasDataLogger><Sys>128</Sys>' +
    '<RawSuprasystolicPressure>AAAA</RawSuprasystolicPressure>' +
    '<RawCuffPPressure>BBBB</RawCuffPPressure><NibpBloodPressures>' +
    '<NibpBloodPressure><Sys>126</Sys><Dia>78</Dia><Alert>x</Alert>' +
    '<RawPressureWave>' + 'Z'.repeat(4000) + '</RawPressureWave>' +
    '<NibpDetailedData>detail</NibpDetailedData></NibpBloodPressure>' +
    '<NibpBloodPressure><Sys>130</Sys><Dia>80</Dia>' +
    '<RawPressureWave>' + 'Y'.repeat(4000) + '</RawPressureWave>' +
    '</NibpBloodPressure></NibpBloodPressures></MeasDataLogger>' +
    '<Results><Result version="5.0" algorithm_revision="1.0.1.0">' +
    '<SNR>28</SNR><sPRV>6</sPRV><cSys>116</cSys><cAIx>24</cAIx>' +
    '<infraDiastolicFiltered>0.1,0.2,0.3</infraDiastolicFiltered>' +
    '<infraDiastolicBeatStartIdxs>0,150,300</infraDiastolicBeatStartIdxs>' +
    '<sAveragePulse>0.1,0.2</sAveragePulse>' +
    '<cAveragePulse>89.9,89.7</cAveragePulse>' +
    '<sBaseLined>' + '1.0,'.repeat(1000) + '</sBaseLined>' +
    '<cEstimate>' + '2.0,'.repeat(1000) + '</cEstimate>' +
    '<baEstimate>' + '3.0,'.repeat(1000) + '</baEstimate>' +
    '</Result></Results></BPplus>';

  const small = minimalXml(xml);

  check('the bulk is gone',
    !/RawPressureWave|NibpDetailedData|<sBaseLined>|<cEstimate>|<baEstimate>/.test(small),
    small.slice(0, 120));
  check('every determination is still there',
    (small.match(/<NibpBloodPressure>/g) || []).length === 2);
  check('and keeps the readings that made the average',
    small.includes('<Sys>126</Sys>') && small.includes('<Sys>130</Sys>'));
  check('the suprasystolic recording survives, since nothing else rebuilds it',
    small.includes('RawSuprasystolicPressure') && small.includes('RawCuffPPressure'));

  // Arrays, and kept: the averaged pulse rather than a full recording, and the
  // shape every derived value was computed from. 2.7 kB on a real file.
  check('the average pulses are kept, unlike the recordings',
    small.includes('<sAveragePulse>') && small.includes('<cAveragePulse>'));

  // A name on the drop list that the document does not contain costs nothing:
  // getElementsByTagName returns an empty collection and the loop does not run.
  check('a drop list naming absent elements is harmless',
    minimalXml('<BPplus><MeasDataLogger><Sys>1</Sys></MeasDataLogger></BPplus>')
      .includes('<Sys>1</Sys>'));

  // 47 kB of Result is seven arrays; 1.2 kB is the 37 values worth having.
  check('every derived value survives, not only SNR',
    ['<SNR>28<', '<sPRV>6<', '<cSys>116<', '<cAIx>24<'].every(v => small.includes(v)));

  // Which algorithm produced them. A later recomputation uses a later revision,
  // and without this there is nothing to say the two differ.
  check('and the algorithm that produced them is named',
    small.includes('algorithm_revision="1.0.1.0"') && small.includes('version="5.0"'));

  // Listed for a firmware that does not exist yet: nothing records the
  // infradiastolic wave while AOBP is enabled, so no file in hand contains it.
  // Named now so that the day one does, a reduced file does not quietly grow by
  // another full rhythm strip.
  check('the infradiastolic arrays go, like every other waveform',
    !small.includes('<infraDiastolicFiltered>') &&
    !small.includes('<infraDiastolicBeatStartIdxs>'));

  check('it is a fraction of the size', small.length < xml.length / 4,
    small.length + ' of ' + xml.length);

  check('something unparseable comes back untouched',
    minimalXml('<BPplus>truncated') === '<BPplus>truncated');
  check('and so does nothing at all', minimalXml('') === '');
}

// -- The dictionary REDCap has to swallow ---------------------------------
// A csv.writer rewrite quoted the byte-order mark into the first field, so the
// first column arrived named  "Variable / Field Name"  with the quotes as part
// of the name. Nothing on this side would have noticed; REDCap would have
// refused the import, on the morning of the session.

console.log('\nthe extended dictionary is importable');

{
  const dir = new URL('../data_dictionary/', import.meta.url);
  const read = name => fs.readFileSync(new URL(name, dir));

  const originalRaw = read('AOBPDEV_DataDictionary_2026-08-31.csv');
  const extendedRaw = read('AOBPDEV_DataDictionary_2026-08-31_extended.csv');

  // The mark belongs to the file, not to the first field: three bytes, then a
  // quote that opens the header cell.
  check('the byte-order mark sits outside the first field',
    extendedRaw[0] === 0xEF && extendedRaw[1] === 0xBB &&
    extendedRaw[2] === 0xBF && extendedRaw[3] === 0x22,
    [...extendedRaw.slice(0, 4)].map(b => b.toString(16)).join(' '));

  // Enough of a CSV parser for a file REDCap itself produced.
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const parse = buf => {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === LF) { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== CR) field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  };

  const original = parse(originalRaw);
  const extended = parse(extendedRaw);

  check('the header is the one REDCap exported',
    JSON.stringify(extended[0]) === JSON.stringify(original[0]),
    JSON.stringify(extended[0][0]));
  check('every row has the same number of columns',
    new Set(extended.map(r => r.length)).size === 1,
    [...new Set(extended.map(r => r.length))].join('/'));

  const ids = extended.slice(1).map(r => r[0]);
  check('no duplicate field names',
    new Set(ids).size === ids.length,
    ids.filter((id, i) => ids.indexOf(id) !== i).join(', '));

  // Every field the module writes has to exist, or the value goes nowhere and
  // only a console warning says so.
  const app = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');
  const written = [...app.matchAll(/^\s+\w+:\s+'(seated_|standing_|sys_)([a-z_]+)',/gm)]
    .map(m => m[1] + m[2]);
  const missing = [...new Set(written)].filter(f => !ids.includes(f));
  check('the instrument has every field the module writes',
    missing.length === 0, 'missing: ' + missing.join(', '));
}

// -- The recording goes to a file, and says so if it did not ---------------
// REDCap keeps only the first part of a value the size of an AOBP XML, so what
// sat in the notes field was a fragment formatted to look like a whole
// document. The file field is where the recording belongs; the notes field now
// says where it went, and what to check it against.

console.log('\nthe recording is filed, not truncated');

{
  const app = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');
  const visit = fs.readFileSync(new URL('harness-visit.html', import.meta.url), 'utf8');

  // The field says one thing. With file storage on it holds a marker and never
  // the XML: writing 125 kB in and overwriting it a moment later put a
  // truncated fragment at risk of being saved, formatted to look like a whole
  // document, describing readings that are already in their own fields.
  check('the XML goes in the notes field only when there is nowhere better',
    /if \(!\(window\.AOBP_CONFIG \|\| \{\}\)\.saveXmlAsFile\) \{/.test(app));
  check('and a lost recording says so, with its length and digest',
    /function markNotStored/.test(app) && /'not-stored'/.test(app));
  check('a stored recording leaves a marker with its length and digest',
    /stored-as-file/.test(app) && /sha256=/.test(app) && /bytes=/.test(app));
  check('and the digest is over bytes, not characters',
    /function byteLength/.test(app) && /TextEncoder\(\)\.encode/.test(app));

  // The measurement is safe either way; the recording is not, and it exists
  // nowhere but the page until it is uploaded.
  check('a failed upload interrupts rather than logging quietly',
    /function uploadFailed/.test(app) && /Do not close this page/.test(app));
  check('and offers another go without repeating the measurement',
    /function showResend/.test(app) && /pendingXml\[mode\]/.test(app));
  check('the marker is only written once the file is actually stored',
    app.indexOf('await markStored') > app.indexOf("reply.status !== 'success'"));

  // No server on the demo host, so the harness answers the call itself.
  check('the harness stands in for the module endpoint',
    /window\.AOBP_MODULE/.test(visit) && /save-xml/.test(visit));

  // The framework has no global ExternalModules.ajax(). Reaching a module from
  // a page means its own JavaScript module object, published by
  // initializeJavascriptModuleObject() — which this module never called, so the
  // call the page made could not have been answered by anything.
  const php = fs.readFileSync(new URL('../AobpIntegration.php', import.meta.url), 'utf8');
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

  check('the module publishes its JavaScript object',
    /initializeJavascriptModuleObject\(\)/.test(php) &&
    /getJavascriptModuleObjectName\(\)/.test(php));
  check('and the page calls that, not a global that does not exist',
    /window\.AOBP_MODULE/.test(app) && !app.includes('ExternalModules.ajax'));

  // A survey respondent is not logged in, so the action has to be declared for
  // the unauthenticated context or the framework refuses it.
  check('save-xml is declared for surveys and for logged-in users',
    (cfg['no-auth-ajax-actions'] || []).includes('save-xml') &&
    (cfg['auth-ajax-actions'] || []).includes('save-xml'));

  // storeFile() registers the bytes and returns a doc id; addFileToField() is
  // what puts that doc on the record, with the instance. Neither alone is
  // enough, and there is no REDCap::saveFile at all, however plausible it reads.
  check('the file is stored and then attached, with the instance',
    /\REDCap::storeFile\(/.test(php) &&
    /\REDCap::addFileToField\(/.test(php) &&
    /\$repeat_instance/.test(php.slice(php.indexOf('addFileToField'))) &&
    !/\\REDCap::saveFile\(/.test(php));   // a CALL, not the comment warning about one

  // The stand-in is a classic script and the harness's own helpers live in a
  // <script type="module"> — module scope, invisible from it. Calling one threw
  // inside ajax(), so every recording the module posted was lost to a
  // ReferenceError that looked exactly like a server refusing the upload, and
  // the check above passed the whole time it was broken.
  const standIn = visit.slice(visit.indexOf('const emEl ='));
  check('and reaches for nothing the module script owns',
    standIn.length > 100 && !standIn.includes('$('),
    standIn.length > 100 ? 'uses $() from the module scope' : 'stand-in not found');
  check('and can be made to fail, so Resend has something to recover from',
    /em-fail/.test(visit));
  check('the harness posts for real, so the path is exercised',
    /saveXmlAsFile: true/.test(visit));
}

// -- The SDK classifies, and says what to do -------------------------------
// Table 5 gives every connection failure code 18, and 18 has to cover "another
// program owns the port" and "the cuff end is out" — which want opposite
// answers from a user. The layer that hits the failure is the only one that
// knows which it was, so it says so, and the advice is keyed off that rather
// than off the browser's phrasing.

console.log('\nthe SDK classifies its own failures');

{
  const { adviseOn, describeError } = await import('../sdk/core/advice.js');
  const { BpPlusError, ErrorReason, connectionError, timeoutError } =
    await import('../sdk/core/errors.js');

  const busy = connectionError('Could not open the serial port: whatever.',
    null, ErrorReason.portBusy);
  const gone = connectionError('Not connected over Web Serial.',
    null, ErrorReason.unplugged);
  const mute = timeoutError('f', 5000);

  check('a busy port is told apart from a loose cable',
    /in use by something else/.test(adviseOn(busy)) &&
    /pushed all the way/.test(adviseOn(mute)));
  check('an unplugged cable says so, rather than blaming the far end',
    /unplugged from the computer/.test(adviseOn(gone)));
  check('a timeout is tagged where it is thrown',
    mute.reason === ErrorReason.noAnswer);
  check('the advice names both ends of the cable',
    /into the device and into the computer/.test(adviseOn(mute)));
  check('and names no button, since it reaches connect and measure alike',
    /switched on, then try again\./.test(adviseOn(mute)));

  // Nothing to say is said as nothing, so a caller does not pad a specific
  // failure with generic advice.
  const kinked = new BpPlusError(11);
  check('a device failure gets no cable advice', adviseOn(kinked) === null);
  check('and describeError falls back to what the device said',
    describeError(kinked) === kinked.message);

  // The whole point: no message text is consulted anywhere in the mapping.
  const advice = fs.readFileSync(new URL('../sdk/core/advice.js', import.meta.url), 'utf8');
  check('the mapping never reads message text',
    !/error\.message\s*\.\s*(match|includes|test)/.test(advice) &&
    !/\.test\(error\.message\)/.test(advice));
}

// -- What the operator is told --------------------------------------------
// The SDK's wording is for a log. "Could not write to the device." is accurate
// and leaves a nurse with nothing to do; both ends of the cable are named,
// because either being loose produces it and the message cannot assume which.

console.log('\nerrors read as something to do');

{
  const app = fs.readFileSync(new URL('../js/aobp.js', import.meta.url), 'utf8');

  // The classification is the SDK's now. The application asks; it does not
  // re-derive the answer from the browser's wording one layer up.
  check('the page no longer reads the browser wording to classify a failure',
    !app.includes('failed to open serial port|port is already open') &&
    /sdk\.adviseOn\(error\)/.test(app));
  check('and says BP+ where the SDK says device, capital included',
    app.includes("'The BP+' : 'the BP+'"));

  // Losing the device mid-visit has to reach the screen on its own.
  check('a device that goes away puts Connect back',
    /device\.on\('state'/.test(app) && /function showConnectButtons/.test(app));

  // The separate Repeat button is gone; Start carries both jobs and renames
  // itself, so one control per position says what pressing it will do.
  const visit = fs.readFileSync(new URL('harness-visit.html', import.meta.url), 'utf8');
  const dict  = fs.readFileSync(
    new URL('../data_dictionary/AOBPDEV_DataDictionary_2026-08-31_extended.csv',
            import.meta.url), 'utf8');

  check('no Repeat button is left anywhere',
    !app.includes('repeat-btn') && !visit.includes('repeat-btn') &&
    !dict.includes('repeat-btn'));
  check('Start renames itself once that position has a reading',
    /startLabel\[mode\]\.replace\(/.test(app));

  // Only the word is swapped, so "Start Seated BP" keeps the instrument's own
  // wording for the position rather than being replaced wholesale.
  check('and only the word Start is swapped',
    app.includes("'Repeat')") && /relabel\('seated',/.test(app));
}

// ── settle() can rethrow when the caller needs to know ──────────────────────
// Teardown steps are best-effort, but the port close is not: a port left open
// makes the next connect impossible, so that one failure has to surface.

console.log('\nsettle: swallow or rethrow');

{
  const src = fs.readFileSync(new URL('../sdk/transports/web-serial.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function settle(promise, ms, rethrow)'));
  const settle = new Function('return ' + body.slice(0, body.indexOf('\n}') + 2))();

  let swallowed = true;
  try { await settle(Promise.reject(new Error('nope')), 200); } catch { swallowed = false; }
  check('swallows by default', swallowed);

  let raised = '';
  try { await settle(Promise.reject(new Error('nope')), 200, true); } catch (e) { raised = e.message; }
  check('rethrows when asked', raised === 'nope');

  let timedOut = '';
  try { await settle(new Promise(() => {}), 80, true); } catch (e) { timedOut = e.message; }
  check('a hang becomes a timeout error when asked', /timed out/.test(timedOut), timedOut);

  const t0 = Date.now();
  await settle(new Promise(() => {}), 80);
  check('and still gives up quietly by default', Date.now() - t0 >= 60);
}

// ── Cable advice belongs only to a timeout ───────────────────────────────────
// timeoutError() and connectionError() share Table 5 code 18, so matching on the
// code alone replaced every connection failure with cable advice — including
// "the port is already open", which is not about the cable.

console.log('\ncode 18 covers two different failures');

{
  const { timeoutError, connectionError } = await import('../sdk/core/errors.js');
  const t = timeoutError('f', 5000);
  const c = connectionError('Could not connect over Web Serial: the port is already open');

  check('both carry the same result code', t.code === c.code);
  check('only the timeout names the command it waited for',
    t.command === 'f' && c.command === undefined);
  check('the connection error keeps its own message',
    /already open/.test(c.message));
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
