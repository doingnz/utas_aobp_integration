/**
 * SDK self-test.
 *
 * Runs the whole stack — session, framing, CRCs, command builders, the
 * simulator — without a device and without a browser. Node needs a DOMParser
 * shim, which the runner supplies; in a browser it is already there.
 *
 *   node sdk/selftest.js          (uses the built-in shim)
 *   import('./sdk/selftest.js').then(m => m.run())    (in a page)
 *
 * The known answers are values the device itself produces, not values this
 * implementation happened to compute, so a change that breaks wire
 * compatibility fails here rather than on the bench.
 */

import { crc8OfText, crc8Hex, crc8 } from './core/crc8.js';
import { crc32NetMf, verifyChaining } from './core/crc32-netmf.js';
import { ByteStream } from './core/byte-stream.js';
import { classify, ResponseKind } from './core/responses.js';
import * as commands from './core/commands.js';
import { BpPlusDevice } from './device/bpplus-device.js';
import { SimulatorTransport } from './transports/simulator.js';
import { UsbSerialTransport } from './transports/usb-serial.js';
import { Pl2303Driver, USB_SERIAL_DRIVERS, allUsbSerialFilters }
  from './transports/usb-serial-drivers.js';
import { recommendedTransport, TransportKind } from './transports/detect.js';
import { buildFeatureWrite, repairFeatureXml } from './device/features.js';
import { eraseSilenceMs, toBase64 } from './device/firmware-update.js';
import { MeasureMode, ResultCode } from './constants.js';

/** Written without an escape sequence so the literal cannot be mangled. */
const CRLF = String.fromCharCode(13, 10);

const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
}

function equal(name, actual, expected) {
  const ok = actual === expected;
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function throws(name, fn, codeExpected) {
  try {
    await fn();
    check(name, false, 'no error was thrown');
  } catch (err) {
    check(name, err.code === codeExpected,
      err.code === codeExpected ? '' : `expected code ${codeExpected}, got ${err.code}`);
  }
}

export async function run() {
  results.length = 0;

  // ── CRC-8 ─────────────────────────────────────────────────────────────────
  // Known answers for the `f` write form, whose checksum is over the device ID
  // followed by every option and value:
  //   f 015D90DE1A0000DA,MEASUREMODE,5,9F
  equal('crc8: MEASUREMODE,5 write checksum',
    crc8Hex('015D90DE1A0000DAMEASUREMODE5'), '9F');
  equal('crc8: MEASUREMODE,4 write checksum',
    crc8Hex('015D90DE1A0000DAMEASUREMODE4'), '0E');
  equal('crc8: FILEPREFIX,AB write checksum',
    crc8Hex('015D90DE1A0000DAFILEPREFIXAB'), '35');
  equal('crc8: FILEPREFIX,NONE write checksum',
    crc8Hex('015D90DE1A0000DAFILEPREFIXNONE'), 'F3');
  equal('crc8: FILEPREFIXCOUNT,1 write checksum',
    crc8Hex('015D90DE1A0000DAFILEPREFIXCOUNT1'), 'B8');
  equal('crc8: empty input is the seed', crc8(new Uint8Array(0)), 0xFF);

  // ── CRC-32, the netMF one ─────────────────────────────────────────────────
  const chain = verifyChaining();
  check('crc32: chains across packet boundaries', chain.ok,
    `whole ${chain.whole}, chained ${chain.chained}`);
  check('crc32: is NOT the reflected CRC-32 everyone else uses', !chain.isReflected,
    chain.isReflected ? 'the reflected algorithm has been wired in by mistake' : '');
  // Non-reflected CRC-32 of "123456789", seed 0, no final XOR.
  equal('crc32: known answer for "123456789"',
    crc32NetMf(new TextEncoder().encode('123456789')) >>> 0, 0x89A1897F);

  // ── Byte stream framing ───────────────────────────────────────────────────
  {
    const stream = new ByteStream(8);
    const enc = new TextEncoder();
    stream.push(enc.encode('M 03\r\nP 0'));
    equal('stream: first line', decode(stream.takeLine()), 'M 03');
    check('stream: partial line is withheld', stream.takeLine() === null);
    stream.push(enc.encode('62\r\n'));
    equal('stream: line completed across chunks', decode(stream.takeLine()), 'P 062');

    stream.push(enc.encode('\r\n\r\nM 00\r\n'));
    equal('stream: first empty line', decode(stream.takeLine()), '');
    equal('stream: second empty line', decode(stream.takeLine()), '');
    equal('stream: mode after the empty lines', decode(stream.takeLine()), 'M 00');

    // Byte mode: exactly n bytes, regardless of any newlines inside them.
    stream.push(enc.encode('abc\r\ndef!!'));
    equal('stream: exact byte count', decode(stream.take(10)), 'abc\r\ndef!!');
  }

  // ── Response classification ───────────────────────────────────────────────
  equal('classify: mode',        classify('M 22').kind, ResponseKind.Mode);
  equal('classify: mode code',   classify('M 22').code, 22);
  equal('classify: pressure',    classify('P 145').mmHg, 145);
  equal('classify: failure',     classify('F 02').code, 2);
  equal('classify: detail echo', classify('D 4').level, 4);
  equal('classify: api version', classify('ver2.4').version, '2.4');
  equal('classify: empty line',  classify('').kind, ResponseKind.Empty);
  equal('classify: W acknowledgement', classify('W').letter, 'W');
  equal('classify: K acknowledgement index', classify('K 17').index, 17);
  equal('classify: bare time reply', classify('20260827143000').timestamp, '20260827143000');
  equal('classify: legacy T time reply', classify('T 20260827143000').timestamp, '20260827143000');
  equal('classify: XML header size', classify('|_XML_Size42329 246_|').size, 42329);
  equal('classify: XML header crc is decimal', classify('|_XML_Size42329 246_|').crc, 246);
  equal('classify: IDs header', classify('IDs_H 110 21').kind, ResponseKind.IdsHeader);
  check('classify: IDs content',
    classify('IDs_Content 34 33 32').ids.join(',') === '34,33,32');
  equal('classify: diagnostic', classify('E "Invalid Command"').message, 'Invalid Command');

  // The reply to `f` begins with '<'. It must classify as a feature list, not
  // as the start of a measurement XML block — this is the misroute that would
  // otherwise hang the whole session.
  equal('classify: feature list is not mistaken for measurement XML',
    classify('<Feature version="3.0"><xml>1.0</xml></Feature>').kind, ResponseKind.Feature);

  // ── Command building ──────────────────────────────────────────────────────
  equal('command: plain start', commands.startMeasurement(), 's 0');
  equal('command: start with patient ID',
    commands.startMeasurement({ patientId: 'ABC-1' }), 's 0,ABC-1');
  equal('command: start with a target',
    commands.startMeasurement({ target: 180, patientId: 'P1' }), 's 180,P1');
  equal('command: seated AOBP with device defaults',
    commands.startMeasurement({ patientId: 'ABC-1', aobp: { bodyPosition: 'seated' } }),
    's 0,ABC-1,,,seated');
  equal('command: fully specified standing AOBP',
    commands.startMeasurement({
      patientId: 'ABC-1',
      aobp: {
        bodyPosition: 'standing',
        initialDelaySeconds: 120,
        repeatDelaySeconds: 45,
        repeats: 2,
      },
    }),
    's 0,ABC-1,,,standing,120,45,2');
  equal('command: AOBP with no patient ID',
    commands.startMeasurement({ aobp: { bodyPosition: 'seated', initialDelaySeconds: 10 } }),
    's 0,,,,seated,10');
  equal('command: detail level', commands.detail(4), 'd 4');
  equal('command: recall most recent', commands.recallMeasurement(0), 'r');
  equal('command: recall by index', commands.recallMeasurement(34), 'r 34');
  equal('command: firmware start',
    commands.firmwareUpdateStart(2882343476, 468448, 512), 'w 2882343476,468448,512');

  await throws('command: patient ID with a comma is refused',
    () => commands.startMeasurement({ patientId: 'SMITH, JOHN' }), ResultCode.invalidCommand);
  await throws('command: patient ID with an angle bracket is refused',
    () => commands.startMeasurement({ patientId: 'A<B' }), ResultCode.invalidCommand);
  await throws('command: AOBP delay above 900 s is refused',
    () => commands.startMeasurement({ aobp: { bodyPosition: 'seated', initialDelaySeconds: 901 } }),
    ResultCode.invalidCommand);
  await throws('command: 6 repeats is refused',
    () => commands.startMeasurement({ aobp: { bodyPosition: 'seated', repeats: 6 } }),
    ResultCode.invalidCommand);
  await throws('command: supine is refused',
    () => commands.startMeasurement({ aobp: { bodyPosition: 'supine' } }),
    ResultCode.invalidCommand);
  await throws('command: AOBP parameters without a body position are refused',
    () => commands.startMeasurement({ aobp: { repeats: 3 } }), ResultCode.invalidCommand);

  equal('command: feature write matches the worked example',
    buildFeatureWrite('015D90DE1A0000DA', [['MEASUREMODE', 5]]),
    'f 015D90DE1A0000DA,MEASUREMODE,5,9F');
  await throws('command: a repeated feature option is refused',
    () => buildFeatureWrite('015D90DE1A0000DA', [['MEASUREMODE', 5], ['MEASUREMODE', 4]]),
    ResultCode.invalidCommand);

  // ── Feature XML repair ────────────────────────────────────────────────────
  {
    const broken = '<Feature version="2.0"><nibp_id>5B2800234   <nibp_id></Feature>';
    const fixed  = repairFeatureXml(broken);
    check('features: malformed closing tag is repaired',
      fixed.xml === '<Feature version="2.0"><nibp_id>5B2800234   </nibp_id></Feature>',
      fixed.xml);
    const wellFormed = '<Feature version="3.0"><nibp_id>X</nibp_id></Feature>';
    check('features: repair leaves well-formed XML alone',
      repairFeatureXml(wellFormed).xml === wellFormed);
  }

  // ── Firmware update ───────────────────────────────────────────────────────
  {
    // A cancel leaves the device silent while it erases the storage the
    // session claimed — about 0.58 s per 64 KB block, so the wait is derived
    // from the declared length. The figures are the ones in the working note.
    check('firmware: cancel wait scales with the image',
      eraseSilenceMs(300 * 1024) > 2000 &&
      eraseSilenceMs(4 * 1024 * 1024) > eraseSilenceMs(470 * 1024),
      `${eraseSilenceMs(300 * 1024)} / ${eraseSilenceMs(470 * 1024)} / ${eraseSilenceMs(4 * 1024 * 1024)}`);

    equal('firmware: base64 of a known packet',
      toBase64(new Uint8Array([0x00, 0x00, 0x1a, 0x10, 0x45, 0x15])), 'AAAaEEUV');
  }

  // ── End to end, against the simulator ─────────────────────────────────────
  await usbSerialAndDetection();
  await endToEnd();
  await aobpEndToEnd();
  await featureWriteEndToEnd();
  await firmwareUpdateEndToEnd();

  return report();
}

/**
 * A firmware transfer, its retry, its refusals and its cancel.
 *
 * The image is synthetic. The CRC-32 that identifies it has been checked
 * against a real firmware image and an independent implementation of the
 * same algorithm; a real image is too large to ship here, so the chaining
 * and non-reflection properties stand in for it.
 */
async function firmwareUpdateEndToEnd() {
  const image = new Uint8Array(1600);          // 4 packets: 512×3 + 64
  for (let i = 0; i < image.length; i++) image[i] = (i * 37 + 11) & 0xFF;

  // ── Refused outside the Service Menu ──────────────────────────────────────
  {
    const transport = new SimulatorTransport({ tickMs: 5 });
    const device = new BpPlusDevice(transport);
    await device.connect();

    const job = device.prepareFirmwareUpdate(image);
    equal('firmware: four packets for a 1600-byte image', job.packetCount, 4);
    check('firmware: a non-zero updateID', job.updateId !== 0, String(job.updateId));

    try {
      await job.run();
      check('firmware: refused outside the Service Menu', false, 'it ran anyway');
    } catch (err) {
      equal('firmware: refused outside the Service Menu with F 14',
        err.code, ResultCode.invalidCommand);
      check('firmware: and says how to get there',
        /Service Menu/.test(err.message) && /buttons/.test(err.message), err.message);
    }
    await device.disconnect();
  }

  // ── A complete transfer ───────────────────────────────────────────
  {
    const transport = new SimulatorTransport({ tickMs: 5 });
    const device = new BpPlusDevice(transport);
    await device.connect();
    transport.enterServiceMenu();

    const job = device.prepareFirmwareUpdate(image);
    const states = [];
    job.on('state', s => states.push(s));

    let lastProgress = null;
    job.on('progress', p => { lastProgress = p; });

    equal('firmware: the transfer completed', await job.run(), 'complete');
    check('firmware: it passed through every state',
      states.join(',').includes('opening,transferring,validating,installing,complete'),
      states.join(','));
    equal('firmware: all four packets were acknowledged', lastProgress.packetIndex, 3);
    equal('firmware: the whole image was sent', lastProgress.bytesSent, image.length);
    equal('firmware: progress reached 100%', lastProgress.percent, 100);

    await device.disconnect();
  }

  // ── A wrong updateID is caught at `v`, not before ─────────────────────────
  {
    const transport = new SimulatorTransport({ tickMs: 5 });
    const device = new BpPlusDevice(transport);
    await device.connect();
    transport.enterServiceMenu();

    const job = device.prepareFirmwareUpdate(image);
    job._updateId = (job._updateId ^ 0xFFFF) >>> 0;    // corrupt it deliberately

    try {
      await job.run();
      check('firmware: a wrong updateID is rejected', false, 'it installed anyway');
    } catch (err) {
      equal('firmware: a wrong updateID fails at validate with F 50',
        err.code, ResultCode.updateFailed);
      check('firmware: and says the old firmware is intact',
        /still running its old firmware/.test(err.message), err.message);
    }
    await device.disconnect();
  }

  // ── F 50 from `w` says restart, never retry ───────────────────────────────
  {
    const transport = new SimulatorTransport({ tickMs: 5, scenario: 'updateStorageBusy' });
    const device = new BpPlusDevice(transport);
    await device.connect();
    transport.enterServiceMenu();

    const attempts = [];
    device.on('log', l => { if (l.dir === 'tx' && l.text.startsWith('w ')) attempts.push(l.text); });

    try {
      await device.prepareFirmwareUpdate(image).run();
      check('firmware: F 50 from w is fatal', false, 'it continued');
    } catch (err) {
      equal('firmware: F 50 from w reports as an update failure',
        err.code, ResultCode.updateFailed);
      check('firmware: and tells the operator to restart first',
        /Restart the BP\+/.test(err.message) && /Do not retry without restarting/.test(err.message),
        err.message);
    }
    equal('firmware: w was sent exactly once, never retried', attempts.length, 1);
    await device.disconnect();
  }

  // ── A cancel that races a packet: the one real stray F in the protocol ────
  {
    const transport = new SimulatorTransport({ tickMs: 5, orphanOnCancel: true });
    const device = new BpPlusDevice(transport);
    await device.connect();
    transport.enterServiceMenu();

    const strays = [];
    device.on('log', l => { if (l.note === 'stray') strays.push(l.text); });

    const job = device.prepareFirmwareUpdate(image);
    job.on('progress', () => job.requestCancel());

    equal('firmware: a cancel racing a packet still reports cancelled',
      await job.run(), 'cancelled');

    await pause(150);
    equal('firmware: the extra F 50 was absorbed, not mis-attributed',
      strays.length, 1);

    // The point of absorbing it: the next command must get its own answer.
    equal('firmware: the session is still in step afterwards',
      await device.readApiVersion(), '2.4');
    await device.disconnect();
  }

  // ── Cancel, taken between packets ─────────────────────────────────────────
  {
    const transport = new SimulatorTransport({ tickMs: 5 });
    const device = new BpPlusDevice(transport);
    await device.connect();
    transport.enterServiceMenu();

    const job = device.prepareFirmwareUpdate(image);

    const sent = [];
    device.on('log', l => { if (l.dir === 'tx') sent.push(l.text); });

    // Ask to stop as soon as the first packet has been acknowledged.
    job.on('progress', () => job.requestCancel());

    const outcome = await job.run();
    equal('firmware: the transfer reports as cancelled', outcome, 'cancelled');
    equal('firmware: its state is cancelled', job.state, 'cancelled');

    // The cancel must sit BETWEEN a k and the next k, never mid-packet.
    const cancelAt = sent.indexOf('c');
    check('firmware: c was sent', cancelAt >= 0, sent.join(' | '));
    const packetsBefore = sent.slice(0, cancelAt).filter(l => l.startsWith('k ')).length;
    const packetsAfter  = sent.slice(cancelAt).filter(l => l.startsWith('k ')).length;
    equal('firmware: one packet went out before the cancel', packetsBefore, 1);
    equal('firmware: and none after it', packetsAfter, 0);

    await device.disconnect();
  }
}

/**
 * A full AOBP run: the M 22 rest period, one M 03 per reading, and a version
 * 7.0 result whose individual readings are readable without the averaged
 * values being confused for them.
 */
async function aobpEndToEnd() {
  const device = new BpPlusDevice(
    new SimulatorTransport({ tickMs: 5, measureMode: MeasureMode.bpPlusAobp })
  );

  const modes = [];
  const pressures = [];
  device.on('mode', m => modes.push(m.code));
  device.on('pressure', p => pressures.push(p));

  await device.connect();

  const features = await device.readFeatures();
  equal('aobp: the device reports AOBP', features.measureMode, MeasureMode.bpPlusAobp);

  const result = await device.measure({
    patientId: 'AOBP-1',
    aobp: { bodyPosition: 'seated', repeats: 3, initialDelaySeconds: 10, repeatDelaySeconds: 30 },
  });

  // The same recording, in the other shape: one per determination, inside each
  // <NibpBloodPressure> and absent from the top level.
  {
    const first = result.cuffRecording(0);
    const last  = result.cuffRecording(result.readings.length - 1);
    check('aobp: each reading carries its own cuff recording',
      first.found && last.found, `${first.reason} / ${last.reason}`);
    check('aobp: a reading past the last one reports absence rather than throwing',
      result.cuffRecording(99).found === false);
  }

  check('aobp: M 22 was sent before the readings',
    modes.indexOf(22) >= 0 && modes.indexOf(22) < modes.indexOf(3), modes.join(','));

  // The device stays in the measuring mode for the whole sequence, so a host
  // sees ONE M 03 however many readings the protocol takes. Counting mode
  // notifications cannot tell you which reading is running; the cuff cycles in
  // the pressure stream can.
  equal('aobp: one M 03 for the whole sequence', modes.filter(c => c === 3).length, 1);
  check('aobp: one cuff inflation per reading',
    countInflations(pressures) === 3, `${countInflations(pressures)} from ${pressures.join(',')}`);

  equal('aobp: the result is version 7.0', result.version, '7.0');
  check('aobp: it is recognised as multi-reading', result.isMultiReading);
  equal('aobp: three individual readings', result.readings.length, 3);
  equal('aobp: protocol type', result.protocol.type, 'aobp');
  equal('aobp: body position', result.protocol.bodyPosition, 'seated');
  equal('aobp: included measurements',
    result.protocol.includedMeasurements.join(','), 'aobp1,aobp2,aobp3');
  equal('aobp: the patient ID round-tripped', result.patientId, 'AOBP-1');

  // The reason element lookup has to be scoped: <Sys> appears once per reading
  // as well as once for the mean, and the headline number must be the mean.
  const readingSys = result.readings.map(r => r.sys);
  const mean = Math.round(readingSys.reduce((a, b) => a + b, 0) / readingSys.length);
  equal('aobp: the headline SYS is the mean, not a single reading',
    result.brachial.sys, mean);
  check('aobp: the readings genuinely differ from the mean',
    new Set(readingSys).size === 3, readingSys.join(','));
  check('aobp: each reading carries its own delay',
    result.readings.every(r => typeof r.actualDelaySeconds === 'number'),
    JSON.stringify(result.readings.map(r => r.actualDelaySeconds)));
  check('aobp: the analysis values still resolve',
    typeof result.central.cSys === 'number' && typeof result.indices.sAI === 'number',
    `${result.central.cSys} / ${result.indices.sAI}`);

  // The firmware refuses the AOBP parameters unless the DEVICE is in AOBP.
  await device.disconnect();

  const plain = new BpPlusDevice(
    new SimulatorTransport({ tickMs: 5, measureMode: MeasureMode.bpPlus })
  );
  await plain.connect();
  try {
    await plain.measure({ aobp: { bodyPosition: 'seated' } });
    check('aobp: refused when the device is not in AOBP', false, 'it ran anyway');
  } catch (err) {
    equal('aobp: refused with F 14 when the device is not in AOBP',
      err.code, ResultCode.invalidCommand);
  }
  await plain.disconnect();

  // A device that reports no measurement mode at all.
  const silent = new BpPlusDevice(
    new SimulatorTransport({ tickMs: 5, reportMeasureMode: false })
  );
  await silent.connect();
  const quiet = await silent.readFeatures();
  equal('features: an absent measureMode reads as null', quiet.measureMode, null);
  equal('features: and is labelled Unknown', quiet.measureModeInfo.label, 'Unknown');
  await silent.disconnect();
}

/**
 * The `f` write form. An accepted write always reboots — the reboot IS the
 * acknowledgement, and there is no success code.
 */
async function featureWriteEndToEnd() {
  const device = new BpPlusDevice(new SimulatorTransport({ tickMs: 5 }));
  await device.connect();
  await device.readFeatures();

  const after = await device.writeFeatures([['MEASUREMODE', MeasureMode.bpPlusAobp]]);
  equal('feature write: the mode changed after the reboot',
    after.measureMode, MeasureMode.bpPlusAobp);

  // A value the firmware refuses.
  try {
    await device.writeFeatures([['MEASUREMODE', 6]]);
    check('feature write: an out-of-range value is refused', false, 'it was accepted');
  } catch (err) {
    equal('feature write: an out-of-range value answers F 14',
      err.code, ResultCode.invalidCommand);
  }

  // The device must still be usable, and unchanged.
  const unchanged = await device.readFeatures();
  equal('feature write: a refused write changed nothing',
    unchanged.measureMode, MeasureMode.bpPlusAobp);

  await device.disconnect();
}

/**
 * The USB-to-serial transport and the transport chooser.
 *
 * The chip handshake cannot be exercised against real hardware here, so it is
 * driven against a recording instead: a fake USBDevice that answers everything
 * and writes down what it was asked. The expected sequence is the PL2303 one
 * from the Linux kernel driver, which is the only published description of it —
 * so a change that breaks a real adapter fails here rather than on a tablet.
 */
async function usbSerialAndDetection() {
  // ── The chooser ─────────────────────────────────────────────────────────
  const desktop = { android: false, mobile: false, handheld: false, secureContext: true,
                    webSerial: true, webUsb: true, webBluetooth: true };
  equal('detect: desktop Chrome uses Web Serial',
    recommendedTransport(desktop).kind, TransportKind.serial);

  // The case this exists for: Chrome on an Android tablet reaches the cable
  // over WebUSB.
  const android = { android: true, mobile: true, handheld: true, secureContext: true,
                    webSerial: false, webUsb: true, webBluetooth: true };
  const pick = recommendedTransport(android);
  equal('detect: Android falls back to the USB-to-serial adapter',
    pick.kind, TransportKind.usbSerial);
  check('detect: and says why', /WebUSB/.test(pick.reason), pick.reason);

  // The regression this file exists to prevent. Chrome 151 on Android DOES
  // expose navigator.serial, but its port list is Bluetooth SPP devices, not
  // the cable — so Web Serial being present is not a reason to prefer it.
  // Measured on a Galaxy S23 Ultra and a Galaxy Tab S10 FE.
  const androidWithSerial = { ...android, webSerial: true };
  equal('detect: Android with Web Serial STILL uses WebUSB',
    recommendedTransport(androidWithSerial).kind, TransportKind.usbSerial);
  check('detect: and explains that Web Serial there is not the cable',
    /Bluetooth/.test(recommendedTransport(androidWithSerial).reason),
    recommendedTransport(androidWithSerial).reason);

  // Chrome's "Desktop site" mode defeats every user-agent signal: platform
  // reads "Linux" and mobile reads false on a device that is plainly a tablet.
  // The touch-derived handheld flag is what survives it, so it alone must be
  // enough to route to WebUSB.
  const desktopModeTablet = { android: false, mobile: false, handheld: true,
                              secureContext: true, webSerial: true,
                              webUsb: true, webBluetooth: true };
  equal('detect: a tablet in desktop-site mode still uses WebUSB',
    recommendedTransport(desktopModeTablet).kind, TransportKind.usbSerial);

  // The converse must hold, or every touch laptop is misrouted onto a WebUSB
  // path that Windows will refuse to claim.
  equal('detect: a desktop with a touch screen stays on Web Serial',
    recommendedTransport({ ...desktop, handheld: false }).kind, TransportKind.serial);

  equal('detect: bluetooth only, when that is all there is',
    recommendedTransport({ ...android, webUsb: false }).kind, TransportKind.bluetooth);

  const none = recommendedTransport({ android: false, mobile: false,
    secureContext: false, webSerial: false, webUsb: false, webBluetooth: false });
  equal('detect: nothing available reports no transport', none.kind, null);
  check('detect: an insecure context is named as the likely cause',
    /secure context/.test(none.reason), none.reason);

  // ── The driver registry ─────────────────────────────────────────────────
  check('usb: the Prolific driver is registered',
    USB_SERIAL_DRIVERS.pl2303 === Pl2303Driver);
  check('usb: its filters name Prolific and nothing else',
    allUsbSerialFilters().every(f => f.vendorId === 0x067B),
    JSON.stringify(allUsbSerialFilters()));

  // ── The handshake ───────────────────────────────────────────────────────
  for (const [name, productId, expected] of [
    ['PL2303HX', 0x2303, [
      'in 0x8484,0', 'out 0x0404,0', 'in 0x8484,0', 'in 0x8383,0', 'in 0x8484,0',
      'out 0x0404,1', 'in 0x8484,0', 'in 0x8383,0', 'out 0x0000,1', 'out 0x0001,0',
      'out 0x0002,68', 'class 0x0020,0 [115200 8N1]', 'class 0x0022,3']],
    ['PL2303GT', 0x23A3, [
      'out 0x0008,0', 'out 0x0009,0',
      'class 0x0020,0 [115200 8N1]', 'class 0x0022,3']],
  ]) {
    const log = [];
    const io = fakeIo(log);
    await Pl2303Driver.open(io, { baudRate: 115200, device: { productId } });
    equal(`usb: the ${name} handshake is unchanged`, log.join(' | '), expected.join(' | '));
  }

  const closeLog = [];
  await Pl2303Driver.close(fakeIo(closeLog));
  equal('usb: closing drops DTR and RTS', closeLog.join(''), 'class 0x0022,0');
}

/** Records the control transfers a driver makes, in a readable form. */
function fakeIo(log) {
  const hex = n => '0x' + Number(n).toString(16).padStart(4, '0');
  const coding = data => {
    if (!data) return '';
    const v = new DataView(data);
    const stop = ['1', '1.5', '2'][v.getUint8(4)] || '?';
    const parity = ['N', 'O', 'E', 'M', 'S'][v.getUint8(5)] || '?';
    return ` [${v.getUint32(0, true)} ${v.getUint8(6)}${parity}${stop}]`;
  };
  return {
    vendorIn:  (value, index) => { log.push(`in ${hex(value)},${index}`); return Promise.resolve({}); },
    vendorOut: (value, index) => { log.push(`out ${hex(value)},${index}`); return Promise.resolve({}); },
    classIn:   (request, value) => { log.push(`classIn ${hex(request)},${value}`); return Promise.resolve({}); },
    classOut:  (request, value, data) => {
      log.push(`class ${hex(request)},${value}${coding(data)}`); return Promise.resolve({});
    },
  };
}

async function endToEnd() {
  const device = new BpPlusDevice(new SimulatorTransport({ tickMs: 5 }));

  const modes = [];
  const pressures = [];
  device.on('mode', m => modes.push(m.code));
  device.on('pressure', p => pressures.push(p));

  await device.connect();

  equal('device: reads the API version', await device.readApiVersion(), '2.4');

  // ── The clock ───────────────────────────────────────────────────────────
  {
    const stamp = await device.readTime();
    check('time: the device reports a 14-digit timestamp', /^[0-9]{14}$/.test(stamp), stamp);

    // A set is answered by reading the clock back, so the reply can be checked
    // against what was asked for rather than merely assumed to have worked.
    const target = new Date(2031, 4, 17, 9, 8, 7);
    const echoed = await device.writeTime(target);
    equal('time: a set is echoed with the new time', echoed, '20310517090807');

    const readBack = commands.parseTimestamp(await device.readTime());
    check('time: the clock kept the value that was set',
      readBack && Math.abs(readBack.getTime() - target.getTime()) < 5000,
      String(readBack));

    // Out by an hour, tolerance one minute: it must write.
    const drifted = await device.syncTime({ toleranceMs: 60 * 1000 });
    check('time: syncTime writes when the drift is beyond tolerance',
      drifted.synced === true, drifted.reason);

    // Now in step, so a second call must leave it alone.
    const settled = await device.syncTime({ toleranceMs: 60 * 1000 });
    check('time: syncTime leaves a clock that is within tolerance alone',
      settled.synced === false, settled.reason);
    check('time: and reports the drift it measured',
      Math.abs(settled.driftMs) < 60 * 1000, String(settled.driftMs) + ' ms');

    // A malformed stamp never reaches the wire: the command is built before
    // anything is sent, so the refusal is local and costs no round trip.
    await throws('time: a malformed stamp is refused before it is sent',
      () => device.writeTime('2031051709'), ResultCode.invalidCommand);

    // The device's own refusal is F 24, reached only by writing the raw line.
    {
      const raw = new SimulatorTransport({ tickMs: 5 });
      const seen = [];
      raw.on('data', bytes => seen.push(decode(bytes)));
      await raw.open();
      await raw.write(new TextEncoder().encode('y 2031051709' + CRLF));
      await pause(60);
      check('time: the device answers a malformed stamp with F 24 and no time',
        seen.join('').includes('F 24') && !/[0-9]{14}/.test(seen.join('')),
        JSON.stringify(seen.join('')));
      await raw.close();
    }

    // A date that does not exist must not roll forward into March.
    equal('time: 31 February parses as nothing',
      commands.parseTimestamp('20310231090807'), null);
    equal('time: a short stamp parses as nothing',
      commands.parseTimestamp('2031023109'), null);
  }

  const features = await device.readFeatures();
  equal('device: reads the device ID', features.deviceId, '015D90DE1A0000DA');
  equal('device: reads the measurement mode', features.measureMode, 0);
  equal('device: labels the measurement mode', features.measureModeInfo.label, 'BP+');

  const idle = await device.readMeasurementInProgress();
  check('device: reports idle through F 22', idle.running === false && idle.code === 22);

  const result = await device.measure({ patientId: 'SELFTEST-1' });

  // The result is stamped from the device's own clock in local time. A UTC
  // stamp reads as correct only where the host sits on UTC.
  {
    const stamped = commands.parseTimestamp(
      String(result.timestamp || '').replace(/[-T:]/g, ''));
    check('device: the result timestamp is the device clock in local time',
      stamped && Math.abs(stamped.getTime() - Date.now()) < 5 * 60 * 1000,
      String(result.timestamp));
  }

  check('device: the measurement checksum matched', result.crcOk);
  equal('device: brachial systolic', result.brachial.sys, 110);
  equal('device: brachial diastolic', result.brachial.dia, 79);
  check('device: central systolic was read from Result',
    typeof result.central.cSys === 'number', String(result.central.cSys));
  check('device: SNR was read from Result',
    typeof result.indices.snr === 'number', String(result.indices.snr));
  check('device: a waveform array parsed',
    result.array('baEstimate').length > 100, String(result.array('baEstimate').length));
  // The cuff recording is nested inside a <RawPressureWave> wrapper, never a
  // direct child of the logger. A single measurement has exactly one; reading
  // it with the plain scoped lookup finds nothing and looks like a device that
  // was never configured to record.
  {
    const cuff = result.cuffRecording(0);
    check('device: the single-measurement cuff recording was found',
      cuff.found, cuff.reason);
    check('device: the cuff recording decoded to plausible mmHg',
      cuff.found && cuff.mmHg.length > 200 && Math.max(...cuff.mmHg) > 50,
      cuff.found ? `${cuff.mmHg.length} samples, peak ${Math.max(...cuff.mmHg).toFixed(1)}` : 'absent');
    equal('device: the cuff recording carries the sample rate', cuff.sampleRate, 200);

    const sup = result.suprasystolicRecording;
    check('device: the suprasystolic recording was found', sup.found, sup.reason);

    // Shares the pressure channel's ADC zero, which only the cuff trace exposes.
    const hold = result.cuffHoldRecording(cuff.zeroCounts);
    check('device: the cuff hold recording was found', hold.found, hold.reason);
    equal('device: a zero was supplied, so no offset warning', hold.reason, '');
  }

  check('device: mode notifications arrived in order',
    modes.join(',').includes('3,4,5,6,7,2'), modes.join(','));
  check('device: pressure notifications arrived', pressures.length >= 8, String(pressures.length));

  // The split-line case the simulator deliberately produces.
  check('device: a pressure split across two chunks was reassembled',
    pressures.includes(20) && pressures.includes(30), pressures.join(','));

  await device.disconnect();

  // ── A failing measurement reports its code ONCE ───────────────────────────
  {
    const failing = new BpPlusDevice(new SimulatorTransport({ tickMs: 5, scenario: 'nibpError' }));
    const failureLines = [];
    failing.on('log', l => { if (l.dir === 'rx' && /^F /.test(l.text)) failureLines.push(l.text); });

    await failing.connect();
    try {
      await failing.measure();
      check('device: a failed measurement rejects', false, 'it resolved instead');
    } catch (err) {
      equal('device: rejects with the device result code', err.code, ResultCode.nibpDeviceError);
      check('device: the error carries a readable message',
        /NIBP device error/i.test(err.message), err.message);
    }

    // A measurement reports its outcome exactly once: one F, then one M 02.
    await pause(120);
    equal('device: the failure is reported exactly once', failureLines.length, 1);

    equal('device: still in step afterwards', await failing.readApiVersion(), '2.4');
    await failing.disconnect();
  }

  // ── Cancel ────────────────────────────────────────────────────────────────
  {
    const cancelling = new BpPlusDevice(new SimulatorTransport({ tickMs: 30 }));
    const cancelFailures = [];
    cancelling.on('log', l => { if (l.dir === 'rx' && /^F /.test(l.text)) cancelFailures.push(l.text); });
    await cancelling.connect();
    const running = cancelling.measure();
    await pause(60);
    await cancelling.cancel();
    try {
      await running;
      check('device: a cancelled measurement rejects', false, 'it resolved instead');
    } catch (err) {
      equal('device: cancel rejects with F 02', err.code, ResultCode.cancelled);
    }
    await pause(120);
    equal('device: a cancel is reported exactly once', cancelFailures.length, 1);
    equal('device: usable after a cancel', await cancelling.readApiVersion(), '2.4');
    await cancelling.disconnect();
  }
}

// ── Runner plumbing ──────────────────────────────────────────────────────────

function decode(bytes) {
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** Rising crossings of an inflated threshold, from an empty cuff. */
function countInflations(pressures) {
  let count = 0;
  let empty = true;
  for (const mmHg of pressures) {
    if (mmHg <= 10) { empty = true; continue; }
    if (empty && mmHg >= 40) { count++; empty = false; }
  }
  return count;
}

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function report() {
  const failed = results.filter(r => !r.ok);
  const lines = results.map(r =>
    `${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`
  );
  return {
    passed: results.length - failed.length,
    failed: failed.length,
    total: results.length,
    lines,
  };
}

// Node entry point. A browser importing this module just gets run().
if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    process.argv[1].replace(/\\/g, '/').endsWith('sdk/selftest.js')) {
  const { JSDOM } = await loadJsdom();
  if (JSDOM) {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
  }
  const outcome = await run();
  for (const line of outcome.lines) console.log(line);
  console.log(`\n${outcome.passed}/${outcome.total} passed, ${outcome.failed} failed`);
  process.exit(outcome.failed === 0 ? 0 : 1);
}

async function loadJsdom() {
  try {
    return await import('jsdom');
  } catch {
    console.error(
      'This self-test needs a DOMParser. In Node, install jsdom:\n' +
      '  npm install --no-save jsdom\n' +
      'In a browser it is built in — import this module and call run().'
    );
    process.exit(2);
    return {};
  }
}
