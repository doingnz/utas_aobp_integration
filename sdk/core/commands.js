/**
 * Command line builders — Table 2.
 *
 * Every command is `<typ><sp><params><cr><lf>`, lower case, with the space
 * omitted when there are no parameters. These functions return the line
 * WITHOUT the CRLF; the session appends it, so nothing here can forget to.
 *
 * Validation happens here rather than in the UI, for one reason: the device
 * rejects and never adjusts. An out-of-range AOBP parameter answers F 14
 * without saying which one was at fault, and a patient ID containing a comma
 * silently shifts every parameter after it. Both are far easier to catch
 * before the line goes out.
 */

import {
  AobpLimits,
  BodyPosition,
  BAUD_RATES,
  DetailLevel,
  FirmwareUpdateLimits,
  ResultCode,
} from '../constants.js';
import { BpPlusError } from './errors.js';

function reject(message) {
  return new BpPlusError(ResultCode.invalidCommand, { message });
}

// ── Patient identifier ───────────────────────────────────────────────────────

/**
 * The device stores whatever it is sent, verbatim, with no unquoting, escaping
 * or validation, and writes it straight into <PatientID> in the result file.
 * So the host owns every constraint:
 *
 *   - no comma      it is read as the start of the next parameter
 *   - no < & >      written to the XML unescaped, making the result unparseable
 *   - no CR or LF   they frame the command
 *
 * This SDK is stricter than the minimum, and matches the reference UI:
 * letters, digits and hyphen only. Quotes are NOT delimiters — a device that
 * receives them stores them as part of the value — so they are refused rather
 * than stripped, which would silently change what was asked for.
 */
export const PATIENT_ID_PATTERN = /^[A-Za-z0-9-]*$/;
export const PATIENT_ID_MAX_LENGTH = 64;

export function validatePatientId(patientId) {
  if (patientId === null || patientId === undefined || patientId === '') return '';

  if (typeof patientId !== 'string') {
    throw reject('The patient ID must be text.');
  }
  if (patientId.length > PATIENT_ID_MAX_LENGTH) {
    throw reject(`The patient ID may be at most ${PATIENT_ID_MAX_LENGTH} characters.`);
  }
  if (!PATIENT_ID_PATTERN.test(patientId)) {
    throw reject('The patient ID may contain only letters, digits and hyphens.');
  }
  return patientId;
}

// ── General operation ────────────────────────────────────────────────────────

/** Request the Terminal API version. Reply: a bare "verN.M". */
export function apiVersion() {
  return '?';
}

/** Query whether a measurement is running. Reply: F 22, F 17 or F 14. */
export function measurementInProgress() {
  return '!';
}

/** Request the current device mode. Reply: M nn. */
export function deviceMode() {
  return 'm';
}

/** Get the device date and time. Reply: a bare 14-digit line, or "T <14>". */
export function getTime() {
  return 'y';
}

/**
 * Set the device date and time.
 * @param {Date|string} when  a Date, or a yyyyMMddHHmmss string
 */
export function setTime(when) {
  let stamp;
  if (when instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}` +
            `${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
  } else {
    stamp = String(when);
  }
  if (!/^\d{14}$/.test(stamp)) {
    throw reject('The time must be 14 digits, yyyyMMddHHmmss.');
  }
  // Legacy devices may require a trailing space before the CRLF (Table 1).
  // It is harmless on current firmware, which trims the line.
  return `y ${stamp} `;
}

/**
 * Parse a device timestamp into a Date.
 *
 * The device keeps local time with no zone attached — `DateTime.Now` on its
 * own clock — so the digits are read as local time here too. Building the Date
 * from parts rather than parsing the string avoids the engine guessing UTC for
 * a bare numeric form.
 *
 * @param {string} stamp  yyyyMMddHHmmss
 * @returns {Date|null}   null when the stamp is not 14 digits or is not a real date
 */
export function parseTimestamp(stamp) {
  const text = String(stamp === null || stamp === undefined ? '' : stamp).trim();
  if (!/^\d{14}$/.test(text)) return null;

  const n = (at, len) => Number(text.substr(at, len));
  const year = n(0, 4), month = n(4, 2), day = n(6, 2);
  const hour = n(8, 2), minute = n(10, 2), second = n(12, 2);

  const when = new Date(year, month - 1, day, hour, minute, second, 0);

  // Rejects 20260231000000 and friends, which Date would roll into March.
  if (when.getFullYear() !== year || when.getMonth() !== month - 1 ||
      when.getDate() !== day || when.getHours() !== hour ||
      when.getMinutes() !== minute || when.getSeconds() !== second) {
    return null;
  }
  return when;
}

/** Set the reporting detail level. Echoed as "D <level>" — consume it. */
export function detail(level = DetailLevel.xml) {
  if (![0, 1, 2, 3, 4, 5].includes(level)) {
    throw reject('The detail level must be 0, 4 or 5.');
  }
  return `d ${level}`;
}

/** Cancel a measurement, or exit pressure-test mode. Accepted at any time. */
export function cancel() {
  return 'c';
}

/** Restart the device. No response to the command itself. */
export function reboot() {
  return 'q';
}

/** Read the feature list. Reply: one line of XML beginning "<Feature". */
export function features() {
  return 'f';
}

/**
 * Change the baud rate. No acknowledgement is sent and the change is
 * immediate — the host must reconnect at the new rate.
 */
export function baudRate(rate) {
  if (!BAUD_RATES.includes(rate)) {
    throw reject(`The baud rate must be one of ${BAUD_RATES.join(', ')}.`);
  }
  return `b ${rate}`;
}

// ── Starting a measurement ───────────────────────────────────────────────────

/**
 * Build an `s` line.
 *
 *   s <target>,<patientID>,<i|d|4>,<margin>,<bodyPosition>,<initialDelay>,
 *     <repeatDelay>,<repeats>
 *
 * Trailing empty parameters are dropped, so a plain measurement is "s 0" and
 * a seated AOBP with device defaults is "s 0,ABC-1,,,seated".
 *
 * No spaces are inserted after the commas. The device trims parameters 5 to 8
 * but takes the patient ID raw, so "s 0, ABC-1" would store a leading space
 * inside <PatientID>.
 *
 * @param {object}  [options]
 * @param {number}  [options.target]        inflation target in mmHg; 0..99 = automatic
 * @param {string}  [options.patientId]
 * @param {'i'|'d'|'4'} [options.nibpMode]  measure on inflate / deflate / slow deflate
 * @param {number}  [options.suprasystolicMargin]  mmHg above systolic; default 40
 * @param {object}  [options.aobp]          AOBP protocol parameters
 * @param {'seated'|'standing'} options.aobp.bodyPosition
 * @param {number} [options.aobp.initialDelaySeconds]  0..900
 * @param {number} [options.aobp.repeatDelaySeconds]   0..180
 * @param {number} [options.aobp.repeats]              1..5
 */
export function startMeasurement(options = {}) {
  const {
    target = 0,
    patientId = '',
    nibpMode = '',
    suprasystolicMargin = null,
    aobp = null,
  } = options;

  if (!Number.isInteger(target) || target < 0 || target > 999) {
    throw reject('The inflation target must be a whole number of mmHg.');
  }
  if (nibpMode !== '' && !['i', 'd', '4'].includes(nibpMode)) {
    throw reject("The NIBP mode must be 'i', 'd' or '4'.");
  }
  if (suprasystolicMargin !== null &&
      (!Number.isInteger(suprasystolicMargin) ||
       suprasystolicMargin <= -100 || suprasystolicMargin >= 100)) {
    throw reject('The suprasystolic margin must be a whole number between -99 and 99.');
  }

  const params = [
    String(target),
    validatePatientId(patientId),
    nibpMode,
    suprasystolicMargin === null ? '' : String(suprasystolicMargin),
    ...buildAobpParams(aobp),
  ];

  // Drop trailing empties so the common case stays "s 0".
  while (params.length > 1 && params[params.length - 1] === '') params.pop();

  return params.length === 1 && params[0] === '0' ? 's 0' : `s ${params.join(',')}`;
}

function buildAobpParams(aobp) {
  if (!aobp) return ['', '', '', ''];

  const { bodyPosition, initialDelaySeconds, repeatDelaySeconds, repeats } = aobp;

  if (!bodyPosition || !(bodyPosition in BodyPosition)) {
    // The 6th to 8th parameters are only valid with the 5th; the device
    // answers F 14 to any of them on their own rather than ignoring them.
    throw reject(
      'An AOBP measurement needs a body position of seated or standing. ' +
      'Those are the only two positions the AOBP protocol defines.'
    );
  }

  const rangeCheck = (value, limits, label) => {
    if (value === null || value === undefined || value === '') return '';
    if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
      throw reject(`${label} must be a whole number between ${limits.min} and ${limits.max}.`);
    }
    return String(value);
  };

  return [
    bodyPosition,
    rangeCheck(initialDelaySeconds, AobpLimits.initialDelaySeconds, 'The initial delay'),
    rangeCheck(repeatDelaySeconds,  AobpLimits.repeatDelaySeconds,  'The delay between measurements'),
    rangeCheck(repeats,             AobpLimits.repeats,             'The number of measurements'),
  ];
}

/**
 * Suprasystolic-only measurement using brachial pressures measured elsewhere.
 * All four numbers are required.
 */
export function startSuprasystolicOnly({ sys, map, dia, pr, patientId = '' }) {
  for (const [name, value] of Object.entries({ sys, map, dia, pr })) {
    if (!Number.isInteger(value)) {
      throw reject(`${name} must be a whole number.`);
    }
  }
  const id = validatePatientId(patientId);
  const params = [sys, map, dia, pr, id];
  while (params.length > 4 && params[params.length - 1] === '') params.pop();
  return `o ${params.join(',')}`;
}

// ── Recall ───────────────────────────────────────────────────────────────────

/** List up to 100 stored measurement IDs. Index 0 is the most recent page. */
export function listMeasurementIds(index = 0) {
  if (!Number.isInteger(index) || index < 0) {
    throw reject('The index must be zero or a positive whole number.');
  }
  return `i ${index}`;
}

/** Retrieve a stored measurement by index. Bare `r` gets the most recent. */
export function recallMeasurement(index = 0) {
  if (!Number.isInteger(index) || index < 0) {
    throw reject('The index must be zero or a positive whole number.');
  }
  return index === 0 ? 'r' : `r ${index}`;
}

// ── Firmware update (Service Menu only) ──────────────────────────────────────

/**
 * Open a firmware-update session.
 * @param {number} updateId    netMF CRC-32 of the whole image; must be non-zero
 * @param {number} imageBytes  image size, at most 4 MB
 * @param {number} packetSize  must be FirmwareUpdateLimits.packetSize
 */
export function firmwareUpdateStart(updateId, imageBytes, packetSize) {
  if (!Number.isInteger(updateId) || updateId === 0) {
    throw reject('The update ID must be a non-zero CRC-32 of the firmware image.');
  }
  if (!Number.isInteger(imageBytes) || imageBytes <= 0 ||
      imageBytes > FirmwareUpdateLimits.imageBytesMax) {
    throw reject('The firmware image must be between 1 byte and 4 MB.');
  }
  if (packetSize !== FirmwareUpdateLimits.packetSize) {
    throw reject(`The packet size must be ${FirmwareUpdateLimits.packetSize} bytes.`);
  }
  return `w ${updateId >>> 0},${imageBytes},${packetSize}`;
}

/** Transfer one packet. Base64 because the device parses lines as UTF-8 text. */
export function firmwareUpdatePacket(index, base64) {
  if (!Number.isInteger(index) || index < 0) {
    throw reject('The packet index must be zero or a positive whole number.');
  }
  return `k ${index},${base64}`;
}

/** Validate and install. On success the device reboots rather than replying. */
export function firmwareUpdateValidate() {
  return 'v';
}
