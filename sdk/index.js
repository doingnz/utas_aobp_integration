/**
 * BP+ JavaScript SDK — public surface.
 *
 * Talks to a Uscom BP+ blood-pressure monitor over the Terminal API (version
 * 2.4, BP+ application firmware 5.3.0.0 series) from a browser.
 *
 *   import { BpPlusDevice, WebSerialTransport } from './sdk/index.js';
 *
 *   const device = new BpPlusDevice(new WebSerialTransport());
 *   device.on('pressure', mmHg => console.log(mmHg));
 *
 *   await device.connect();
 *   const result = await device.measure({ patientId: 'TEST-001' });
 *   console.log(result.brachial.sys, result.central.cSys);
 *
 * Nothing in this package touches the DOM, a UI framework or localStorage.
 * The reference application in app/ is one consumer of it and can be deleted
 * without affecting anything here.
 *
 * See docs/SDK.md for the integration guide.
 */

// ── The device ───────────────────────────────────────────────────────────────

export {
  BpPlusDevice,
  DeviceState,
  measurementTimeoutMs,
  parseSummaryLine,
} from './device/bpplus-device.js';

export { BpPlusMeasurement, decodeUint16Base64, unusableReason, alertsOf, parseAlerts, classifyAlert, minimalXml } from './device/measurement.js';

export {
  BpPlusFeatures,
  FeatureOption,
  buildFeatureWrite,
  repairFeatureXml,
} from './device/features.js';

export {
  FirmwareUpdateJob,
  FirmwareUpdateState,
  eraseSilenceMs,
  toBase64,
} from './device/firmware-update.js';

// ── Transports ───────────────────────────────────────────────────────────────

export { Transport, TransportState }      from './transports/transport.js';
export { SimulatorTransport }             from './transports/simulator.js';
export { WebSerialTransport }             from './transports/web-serial.js';
export {
  UsbSerialTransport,
  // An alias fixed to the Prolific driver; prefer UsbSerialTransport.
  WebUsbPl2303Transport,
} from './transports/usb-serial.js';

// The chip drivers, and what adding another involves.
export {
  Pl2303Driver,
  USB_SERIAL_DRIVERS,
  allUsbSerialFilters,
} from './transports/usb-serial-drivers.js';

// Which transport this browser can actually use — the Android case in
// particular, where there is no Web Serial at all.
export {
  TransportKind,
  describeEnvironment,
  recommendedTransport,
} from './transports/detect.js';
export { WebBluetoothTransport, BLE_PROFILES } from './transports/web-bluetooth.js';

// ── Errors ───────────────────────────────────────────────────────────────────

export { BpPlusError, ErrorReason } from './core/errors.js';

// What to tell the person holding the device, as opposed to what to log.
export { describeError, adviseOn } from './core/advice.js';

// ── Protocol vocabulary ──────────────────────────────────────────────────────

export {
  DeviceMode,
  ResultCode,
  MeasureMode,
  BodyPosition,
  DetailLevel,
  AobpDefaults,
  AobpLimits,
  BAUD_RATES,
  NIBP_INFLATION_TARGETS,
  SELECTABLE_MEASURE_MODES,
  FirmwareUpdateLimits,
  describeMode,
  describeResult,
  describeMeasureMode,
  describeSignalQuality,
  describeRhythm,
  SIGNAL_QUALITY_BANDS,
  IRREGULAR_RHYTHM_SPRV_MS,
  isMeasuringMode,
  isMultiReadingMode,
  isFailureCode,
} from './constants.js';

// ── Lower layers ─────────────────────────────────────────────────────────────
// Exported so an integrator can build something this SDK does not do — drive
// the protocol by hand, add a transport, or parse a captured trace.

export { Session }     from './core/session.js';
export { Emitter }     from './core/emitter.js';
export { ByteStream }  from './core/byte-stream.js';
export { classify, ResponseKind, isNotification } from './core/responses.js';
export { crc8, crc8OfText, crc8Hex }             from './core/crc8.js';
export { crc32NetMf, verifyChaining }            from './core/crc32-netmf.js';

export * as commands from './core/commands.js';

// Patient-ID rules, so a UI can filter input to what the device can store
// rather than discovering the constraint when a result file will not parse.
export {
  validatePatientId,
  PATIENT_ID_PATTERN,
  PATIENT_ID_MAX_LENGTH,
  // The inverse of the device's timestamp format, for comparing its clock
  // with this computer's. See BpPlusDevice.syncTime().
  parseTimestamp,
} from './core/commands.js';

/** SDK version, independent of the application's. */
export const SDK_VERSION = '1.2.1';

/** The Terminal API version this SDK is written against. */
export const TERMINAL_API_VERSION = '2.4';
