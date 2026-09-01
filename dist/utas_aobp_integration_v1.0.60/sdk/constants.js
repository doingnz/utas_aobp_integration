/**
 * Protocol constants: the device modes reported by `M nn`, the result codes
 * reported by `F nn`, and the measurement-mode and body-position
 * vocabularies the `f` and `s` commands use.
 *
 * The names match the ones the device firmware uses, so a value seen here
 * and a value seen in a device log read the same way.
 */

// ── Device modes (M nn) — Table 4 ────────────────────────────────────────────

export const DeviceMode = Object.freeze({
  initial:                   0,
  offline:                   1,
  ready:                     2,
  measuringBp:               3,
  deflatingCuff:             4,
  inflatingToSs:             5,
  acquireData:               6,
  processData:               7,
  selectStorage:             8,
  storeRecall:               9,
  extraInfo:                10,
  safetyLock:               11,
  serviceMenu:              12,
  serviceMenuManometer:     13,
  serviceCharacterizingSys: 14,
  setTarget:                15,
  downloadApp:              16,
  settings:                 17,
  selectLanguage:           18,
  setDatetime:              19,
  centralPress:             20,
  measurePressureTest:      21,
  countDownAobp:            22,
  selectAobpMode:           23,
});

const DEVICE_MODE_NAMES = Object.fromEntries(
  Object.entries(DeviceMode).map(([name, code]) => [code, name])
);

const DEVICE_MODE_TEXT = Object.freeze({
  0:  'Starting up',
  1:  'Offline',
  2:  'Ready',
  3:  'Measuring blood pressure',
  4:  'Deflating cuff',
  5:  'Inflating to suprasystolic',
  6:  'Acquiring pulse wave',
  7:  'Calculating',
  8:  'Select storage',
  9:  'Store / recall',
  10: 'Extra information',
  11: 'Safety lock',
  12: 'Service menu',
  13: 'Service menu — manometer',
  14: 'Service menu — characterising systolic',
  15: 'Set target',
  16: 'Download app',
  17: 'Settings',
  18: 'Select language',
  19: 'Set date and time',
  20: 'Central pressure',
  21: 'Pressure test',
  22: 'Rest period',
  23: 'Select AOBP position',
});

/** Table 4 requires unknown mode codes to be informational, never an error. */
export function describeMode(code) {
  return {
    code,
    name: DEVICE_MODE_NAMES[code] || `mode${code}`,
    text: DEVICE_MODE_TEXT[code] || `Mode ${String(code).padStart(2, '0')}`,
    known: code in DEVICE_MODE_NAMES,
  };
}

/** Modes in which the device is running a measurement and answers F 17. */
export function isMeasuringMode(code) {
  return code >= DeviceMode.measuringBp && code <= DeviceMode.processData;
}

// ── Result codes (F nn) — Table 5 ────────────────────────────────────────────

export const ResultCode = Object.freeze({
  failedToStart:            0,
  noValidSystolic:          1,
  cancelled:                2,
  failedToReinflate:        3,
  processingError:          4,
  processedToSuprasystolic: 5,
  processedToFindPoints:    6,
  processedToCentralBP:     7,
  processingFinished:       8,
  noMeasurement:            9,
  measurementTimeout:      10,
  nibpDeviceError:         11,
  measurementDataInvalid:  12,
  measurementBPOutOfRange: 13,
  invalidCommand:          14,
  failedSelfTest:          15,
  deviceIsBusy:            17,
  // 18..21 are reserved for host libraries and are produced by this SDK,
  // never by the device.
  timeoutOrConnectionError: 18,
  dataReceivingError:       19,
  dataReceivingTimeout:     20,
  invalidPortName:          21,
  noMeasurementInProgress: 22,
  failedSafetyTest:        23,
  invalidDateTime:         24,
  invalidPatientMode:      25,
  invalidBaudRate:         26,
  sdCardRequired:          27,
  sdCardInvalid:           28,
  sdCardLocked:            29,
  updateFailed:            50,
  success:                 99,
});

const RESULT_CODE_NAMES = Object.fromEntries(
  Object.entries(ResultCode).map(([name, code]) => [code, name])
);

const RESULT_CODE_TEXT = Object.freeze({
  0:  'The measurement could not be started.',
  1:  'No valid systolic pressure was found.',
  2:  'The measurement was cancelled.',
  3:  'Pneumatic error — the cuff could not be re-inflated for the suprasystolic measurement.',
  4:  'The measurement data could not be processed.',
  5:  'The suprasystolic pulse wave analysis failed.',
  6:  'Feature points could not be found in the pulse wave.',
  7:  'Central blood pressure could not be calculated.',
  8:  'The measurement did not finish.',
  9:  'No measurement found. A stored file may exist but hold no usable measurement — try recalling it without reprocessing.',
  10: 'The measurement did not complete within the permitted time.',
  // F 11 is the blood-pressure module's general fault code, and carries no cause
  // of its own: FinishMeasurementCode.nibpDeviceError in the firmware is a bare
  // enum member with nothing attached. It was worded here as "the retry limit
  // was reached", which is one cause among several — a BP+ that aborted on the
  // FIRST attempt with over-pressure reports the same 11, and that wording sent
  // an operator looking for retries that never happened.
  //
  // The specific cause travels separately, in the saved record's per-reading
  // Alert, which firmware composes as "Unable to measure BP: Over Pressure
  // (C19-1)" — category, then the NIBP module's error code and reason.
  // device.measure() carries it on the error as `alerts`, for a host to show
  // separately, so this text only has to name the category.
  11: 'The blood-pressure module reported an error.',
  12: 'The measurement data is invalid.',
  13: 'Blood pressure was outside the measurable range.',
  14: 'Invalid command — the device is on a screen or in a mode that cannot carry it out.',
  15: 'The device failed its self-test and cannot carry out this command yet.',
  17: 'The device is busy with a measurement.',
  18: 'The device did not answer in time.',
  19: 'The data received from the device could not be read.',
  20: 'Timed out while receiving data from the device.',
  21: 'The port could not be opened.',
  22: 'No measurement is in progress.',
  23: 'The device failed its safety test.',
  24: 'Invalid date or time.',
  25: 'Invalid patient mode.',
  26: 'Invalid baud rate.',
  27: 'An SD card is required.',
  28: 'The SD card is not valid.',
  29: 'The SD card is locked.',
  50: 'The firmware update could not continue and the session has ended.',
  99: 'Success.',
});

export function describeResult(code) {
  return {
    code,
    name: RESULT_CODE_NAMES[code] || `code${code}`,
    text: RESULT_CODE_TEXT[code] || `The device reported result code ${code}.`,
    known: code in RESULT_CODE_NAMES,
  };
}

/**
 * F 22 answers `!` on the Ready screen and F 99 acknowledges success — both are
 * framed as failures but neither is one. Everything else in Table 5 is.
 */
export function isFailureCode(code) {
  return code !== ResultCode.noMeasurementInProgress && code !== ResultCode.success;
}

// ── Measurement modes — the `f` MEASUREMODE option ───────────────────────────

export const MeasureMode = Object.freeze({
  bpPlus:            0,   // 'BP+'            single BP + suprasystolic PWA (default)
  bpOnly:            1,   // 'Only BP'        experimental, not offered by this SDK's UI
  suprasystolicOnly: 2,   // reserved — the firmware refuses it with F 14
  infraDiaBpPlus:    3,   // 'InfraDia & BP+' infradiastolic @50 mmHg, BP and PWA
  bpPlus3:           4,   // 'BP+ [3]'        3 BP readings, one PWA, no AOBP timing
  bpPlusAobp:        5,   // 'BP+ AOBP'       3 BP and one PWA under the AOBP protocol
});

const MEASURE_MODE_LABELS = Object.freeze({
  0: 'BP+',
  1: 'Only BP',
  2: 'Suprasystolic only',
  3: 'InfraDia & BP+',
  4: 'BP+ [3]',
  5: 'BP+ AOBP',
});

/** The modes a host may select. 1 is experimental and 2 is refused by the device. */
export const SELECTABLE_MEASURE_MODES = Object.freeze([
  MeasureMode.bpPlus,
  MeasureMode.infraDiaBpPlus,
  MeasureMode.bpPlus3,
  MeasureMode.bpPlusAobp,
]);

export function describeMeasureMode(mode) {
  if (mode === null || mode === undefined) {
    return { mode: null, label: 'Unknown', known: false };
  }
  return {
    mode,
    label: MEASURE_MODE_LABELS[mode] || `Mode ${mode}`,
    known: mode in MEASURE_MODE_LABELS,
  };
}

/** Modes that record several BP readings, so the result XML is version 7.0. */
export function isMultiReadingMode(mode) {
  return mode === MeasureMode.bpPlus3 || mode === MeasureMode.bpPlusAobp;
}

// ── AOBP ────────────────────────────────────────────────────────────────────

/**
 * Only seated and standing are defined AOBP protocols. `supine` exists in the
 * BP+ data model but the device answers F 14 to it, so it is not offered here.
 */
export const BodyPosition = Object.freeze({
  seated:   'seated',
  standing: 'standing',
});

/** Firmware limits — the device rejects out-of-range values, it never clamps. */
export const AobpLimits = Object.freeze({
  initialDelaySeconds: { min: 0, max: 900 },
  repeatDelaySeconds:  { min: 0, max: 180 },
  repeats:             { min: 1, max: 5 },
});

/** What the device does when a parameter is omitted. */
export const AobpDefaults = Object.freeze({
  seated:   { initialDelaySeconds: 300, repeatDelaySeconds: 30, repeats: 3 },
  standing: { initialDelaySeconds:  60, repeatDelaySeconds: 30, repeats: 2 },
});

// ── Measurement quality ──────────────────────────────────────────

/**
 * Signal-to-noise bands, in dB. Every band closes inclusively at its upper
 * edge, and the reported SNR is a whole number, so the boundary values are a
 * real population rather than a rounding curiosity.
 *
 * Invalid is not a theoretical floor: a measurement the device has decided not
 * to trust has its reported SNR set to zero, which lands here.
 */
export const SIGNAL_QUALITY_BANDS = Object.freeze([
  { max: 0,        label: 'Invalid',    usable: false },
  { max: 6,        label: 'Poor',       usable: false },
  { max: 9,        label: 'Acceptable', usable: true  },
  { max: 12,       label: 'Good',       usable: true  },
  { max: Infinity, label: 'Excellent',  usable: true  },
]);

/**
 * Classify a signal-to-noise ratio.
 * @param {number|null} snr  in dB
 * @returns {{snr: number|null, label: string, usable: boolean, known: boolean}}
 */
export function describeSignalQuality(snr) {
  if (snr === null || snr === undefined || !Number.isFinite(snr)) {
    return { snr: null, label: 'Unknown', usable: false, known: false };
  }
  const band = SIGNAL_QUALITY_BANDS.find(b => snr <= b.max);
  return { snr, label: band.label, usable: band.usable, known: true };
}

/**
 * Pulse-rate variability above which the rhythm is reported as irregular, in
 * milliseconds. sPRV is the RMSSD of the beat intervals during the
 * suprasystolic capture.
 */
export const IRREGULAR_RHYTHM_SPRV_MS = 100;

/**
 * @param {number|null} sPRV  in milliseconds
 * @returns {{sPRV: number|null, irregular: boolean, known: boolean}}
 */
export function describeRhythm(sPRV) {
  if (sPRV === null || sPRV === undefined || !Number.isFinite(sPRV)) {
    return { sPRV: null, irregular: false, known: false };
  }
  return { sPRV, irregular: sPRV > IRREGULAR_RHYTHM_SPRV_MS, known: true };
}

// ── Misc protocol limits ────────────────────────────────────────────────────

export const NIBP_INFLATION_TARGETS = Object.freeze([
  80, 100, 120, 140, 160, 180, 200, 220, 240, 280,
]);

export const BAUD_RATES = Object.freeze([
  4800, 9600, 19200, 38400, 57600, 115200, 230400,
]);

export const DetailLevel = Object.freeze({
  summary:          0,  // the S line
  xml:              4,  // full measurement XML — what this SDK uses
  storedXmlNoRework: 5, // stored XML returned as held, without reprocessing
});

/** Firmware-update limits, as enforced by the device. */
export const FirmwareUpdateLimits = Object.freeze({
  /** The only packet size the device accepts. */
  packetSize: 512,
  imageBytesMax: 4 * 1024 * 1024,
});
