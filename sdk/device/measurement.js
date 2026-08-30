/**
 * A BP+ measurement result.
 *
 * Wraps the XML the device returns at detail level 4 and exposes it as typed
 * values, while keeping the raw text so an integrator who wants something this
 * class does not surface can go and get it.
 *
 * Element lookup is SCOPED, which matters more than it looks. In AOBP and
 * BP+ [3] the document carries a <NibpBloodPressures> block with one
 * <NibpBloodPressure> per reading, and each of those has its own <Sys>, <Dia>,
 * <Map> and <Pr>. A document-wide getElementsByTagName('Sys')[0] returns the
 * averaged value only because the average happens to be serialised first — it
 * is right by element ordering alone, and a future firmware that reordered
 * them would silently swap an average for a single reading.
 *
 * So:
 *   brachial values  direct children of <MeasDataLogger>
 *   analysis values  children of <Results><Result>
 *   per reading      children of each <NibpBloodPressure>
 *
 * The two sets do not overlap: Result has no Sys/Dia/Map/Pr, and
 * MeasDataLogger has no cSys/SNR/sAI.
 */

import { receiveError } from '../core/errors.js';
import { describeSignalQuality, describeRhythm, ResultCode } from '../constants.js';

export class BpPlusMeasurement {

  /**
   * @param {string}  xml
   * @param {object} [meta]
   * @param {boolean} [meta.crcOk]     false when the block checksum did not match
   * @param {number}  [meta.sizeBytes]
   */
  constructor(xml, meta = {}) {
    this.xml       = xml;
    this.crcOk     = meta.crcOk !== false;
    this.sizeBytes = meta.sizeBytes ?? null;
    this.receivedAt = new Date();

    const parsed = new DOMParser().parseFromString(xml, 'text/xml');
    const failure = parsed.getElementsByTagName('parsererror')[0];
    if (failure) {
      throw receiveError(
        'The measurement XML could not be parsed: ' +
        (failure.textContent || '').trim().split('\n')[0]
      );
    }

    this.document = parsed;
    this._root    = parsed.documentElement;
    this._logger  = firstChildNamed(this._root, 'MeasDataLogger');
    this._result  = this._findResult();

    if (!this._logger) {
      throw receiveError('The measurement XML has no MeasDataLogger element.');
    }
  }

  _findResult() {
    const results = firstChildNamed(this._root, 'Results');
    return results ? firstChildNamed(results, 'Result') : null;
  }

  // ── Identity and provenance ───────────────────────────────────────────────

  /** The document version: 6.0 for a single reading, 7.0 for AOBP and BP+ [3]. */
  get version() { return this._root.getAttribute('version'); }

  get rootName() { return this._root.nodeName; }   // 'BPplus', or 'CardioScope'

  get patientId() {
    const el = firstChildNamed(this._root, 'PatientID');
    return el ? text(el) : '';
  }

  /** Every attribute of <MeasDataLogger>, as a plain object. */
  get info() {
    const out = {};
    for (const attr of this._logger.attributes) out[attr.name] = attr.value;
    return out;
  }

  get guid()      { return this._logger.getAttribute('guid'); }
  get deviceId()  { return this._logger.getAttribute('device_id'); }
  get timestamp() { return this._logger.getAttribute('datetime'); }

  // ── Values ────────────────────────────────────────────────────────────────

  /** Brachial pressures, from the direct children of <MeasDataLogger>. */
  get brachial() {
    return {
      sys: this.number('Sys'),
      dia: this.number('Dia'),
      map: this.number('Map'),
      pr:  this.number('Pr'),
    };
  }

  /** Central pressures and the pulse-wave indices, from <Result>. */
  get central() {
    return {
      cSys: this.number('cSys'),
      cDia: this.number('cDia'),
      cMap: this.number('cMap'),
    };
  }

  get indices() {
    return {
      snr:        this.number('SNR'),
      sPR:        this.number('sPR'),
      sPRV:       this.number('sPRV'),
      sAI:        this.number('sAI'),
      sPP:        this.number('sPP'),
      sPPV:       this.number('sPPV'),
      sSEP:       this.number('sSEP'),
      sRWTTFoot:  this.number('sRWTTFoot'),
      sRWTTPeak:  this.number('sRWTTPeak'),
      sDpDtMax:   this.number('sDpDtMax'),
    };
  }

  /**
   * Signal quality, from the suprasystolic capture's signal-to-noise ratio.
   * @returns {{snr, label, usable, known}}
   */
  get signalQuality() {
    return describeSignalQuality(this.number('SNR'));
  }

  /**
   * Whether the rhythm was irregular, from the pulse-rate variability measured
   * during the suprasystolic capture.
   * @returns {{sPRV, irregular, known}}
   */
  get rhythm() {
    return describeRhythm(this.number('sPRV'));
  }

  get alert() {
    const el = firstChildNamed(this._logger, 'Alert');
    return el ? text(el) : '';
  }

  /**
   * One named value, looked up in <Result> first and then among the direct
   * children of <MeasDataLogger> — never inside a per-reading block.
   *
   * @returns {string|null}
   */
  value(tag) {
    if (this._result) {
      const fromResult = firstChildNamed(this._result, tag);
      if (fromResult) return text(fromResult);
    }
    const fromLogger = firstChildNamed(this._logger, tag);
    return fromLogger ? text(fromLogger) : null;
  }

  /** @returns {number|null} */
  number(tag) {
    const raw = this.value(tag);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /** A comma-separated waveform or index array. @returns {number[]} */
  array(tag) {
    const raw = this.value(tag);
    if (!raw) return [];
    return raw.split(',').map(Number);
  }

  // ── Multi-reading protocols: AOBP and BP+ [3] ─────────────────────────────

  /** True when the result carries individual BP readings. */
  get isMultiReading() { return this.readings.length > 0; }

  /**
   * The individual BP readings, in the order the device recorded them.
   * Empty for a single-reading measurement.
   */
  get readings() {
    if (this._readings) return this._readings;

    const block = firstChildNamed(this._logger, 'NibpBloodPressures');
    this._readings = block
      ? childrenNamed(block, 'NibpBloodPressure').map(el => ({
          id:       el.getAttribute('id'),
          sys:      childNumber(el, 'Sys'),
          dia:      childNumber(el, 'Dia'),
          map:      childNumber(el, 'Map'),
          pr:       childNumber(el, 'Pr'),
          dateTime: childText(el, 'DateTime'),
          alert:    childText(el, 'Alert'),
          irregularHeartBeat: childText(el, 'IrregularHeartBeat'),
          motionDetected:     childText(el, 'MotionDetected'),
          // Present only for AOBP and BP+ [3]: the delay asked for, and the
          // delay actually taken before this reading.
          requestedDelaySeconds: childNumber(el, 'AobpRequestedDelay'),
          actualDelaySeconds:    childNumber(el, 'AobpDelay'),
          // The cuff pressure recorded during this determination, when the
          // device was configured to keep it. See cuffRecording().
          rawCuffPressure: childText(
            firstChildNamed(el, 'RawPressureWave'), 'RawCuffPressureWave'),
          rawSampleCount: childNumber(
            firstChildNamed(el, 'RawPressureWave'), 'RawSampleCount'),
        }))
      : [];

    return this._readings;
  }

  /**
   * The protocol this measurement was recorded under.
   * `type` is null for an ordinary BP+ measurement.
   */
  get protocol() {
    const included = this._logger.getAttribute('includedMeasurements');
    return {
      type:            this._logger.getAttribute('protocolType'),
      bodyPosition:    this._logger.getAttribute('bodyPosition'),
      calculationType: this._logger.getAttribute('calculationType'),
      includedMeasurements: included ? included.split(',') : [],
    };
  }

  // ── Raw pressure recordings ───────────────────────────────────────────────

  /** Samples per second for every raw recording in this measurement. */
  get sampleRate() {
    return this.number('SampleRate') || 200;
  }

  /**
   * The suprasystolic pressure recording, in mmHg.
   *
   * This is the high-gain pulse channel captured while the cuff is held above
   * systolic — the trace the pulse-wave analysis is derived from. Its
   * amplitude is a fraction of a mmHg, which is why it needs its own scale
   * factor rather than sharing the cuff's.
   *
   * @returns {{found: boolean, mmHg: Float64Array, sampleRate: number, reason: string}}
   */
  get suprasystolicRecording() {
    return this._decodeRecording(
      this.value('RawSuprasystolicPressure'),
      this.number('mmHgPerCountSuprasystolicChannel'),
      'This measurement has no suprasystolic recording.'
    );
  }

  /**
   * The cuff pressure held during the suprasystolic capture, in mmHg.
   *
   * On the same clock as the suprasystolic channel. It shares the pressure
   * channel's ADC zero, which only a full cuff recording exposes — so the zero
   * has to be passed in. Without it the trace carries the ADC offset, which is
   * a constant shift rather than a distortion, and `reason` says so.
   *
   * Note this recording cannot supply its own zero the way the others can: it
   * begins with the cuff already inflated, so the opening samples are the held
   * pressure, not atmospheric.
   *
   * @param {number} [zeroCounts] the ADC zero, from a cuff recording
   */
  cuffHoldRecording(zeroCounts = null) {
    return this._decodeRecording(
      this.value('RawCuffPPressure'),
      this.number('mmHgPerCountPressureChannel'),
      'This measurement has no cuff hold recording.',
      { zero: zeroCounts ?? 0, reason: zeroCounts === null
          ? 'The ADC zero is unknown, so this trace is offset by it.' : '' }
    );
  }

  /**
   * The cuff pressure recorded during one BP determination, in mmHg — the
   * inflate and deflate ramp the device measured the reading from.
   *
   * The device only keeps this when it has been configured to; by default it
   * does not, and `found` is false with a reason saying so.
   *
   * The two protocols put this in different places, and neither is a direct
   * child of the logger:
   *
   *   single     MeasDataLogger > PressureWaves > RawPressureWave
   *   AOBP / [3] MeasDataLogger > NibpBloodPressures > NibpBloodPressure
   *                              > RawPressureWave
   *
   * A multi-reading result records the cuff once per determination, so the
   * wrapper travels with the reading and there is no `<PressureWaves>` element
   * at all. Reading only one of the two shapes finds nothing on the other and
   * looks exactly like a device that was never configured to record.
   *
   * @param {number} [index] which reading; 0 for a single-reading measurement
   */
  cuffRecording(index = 0) {
    const reading = this.readings[index];
    const base64 = reading
      ? reading.rawCuffPressure
      : childText(this._pressureWave(index), 'RawCuffPressureWave');

    return this._decodeRecording(
      base64,
      this.number('mmHgPerCountPressureChannel'),
      'The device did not record the cuff pressure for this measurement. ' +
      'It keeps the raw cuff trace only when configured to.'
    );
  }

  /**
   * The `<RawPressureWave>` wrapper for a single-reading measurement.
   *
   * The container is plural because a protocol may record more than one; a
   * plain BP+ measurement puts exactly one in it. Tolerates the wrapper sitting
   * directly under the logger, so a device that omits the container still
   * reads.
   */
  _pressureWave(index = 0) {
    const container = firstChildNamed(this._logger, 'PressureWaves');
    if (container) return childrenNamed(container, 'RawPressureWave')[index] || null;
    return index === 0 ? firstChildNamed(this._logger, 'RawPressureWave') : null;
  }

  /**
   * Decode one base64 uint16 recording into mmHg.
   *
   *   mmHg = (count - zero) x scale
   *
   * The zero is the ADC reading at atmospheric pressure, taken as the median
   * of the first samples because every recording starts before the cuff does.
   * A mean would be pulled by any early transient; a single first sample would
   * be whatever noise it happened to land on.
   */
  _decodeRecording(base64, scale, absentReason, options = {}) {
    if (!base64 || !base64.trim()) {
      return { found: false, mmHg: new Float64Array(0), sampleRate: this.sampleRate, reason: absentReason };
    }
    if (!Number.isFinite(scale)) {
      return {
        found: false,
        mmHg: new Float64Array(0),
        sampleRate: this.sampleRate,
        reason: 'The measurement does not carry the scale factor for this channel.',
      };
    }

    const counts = decodeUint16Base64(base64);
    if (counts.length === 0) {
      return { found: false, mmHg: new Float64Array(0), sampleRate: this.sampleRate, reason: absentReason };
    }

    const zero = options.zero ?? medianOfFirst(counts, 20);
    // The zero is the ADC reading at atmospheric pressure; a caller that needs
    // to correct another channel on the same ADC has no other way to get it.
    const mmHg = new Float64Array(counts.length);
    for (let i = 0; i < counts.length; i++) mmHg[i] = (counts[i] - zero) * scale;

    return { found: true, mmHg, zeroCounts: zero, sampleRate: this.sampleRate, reason: options.reason || '' };
  }

  /** A one-line summary, for logs and for the reference UI's status line. */
  get summary() {
    const b = this.brachial;
    const c = this.central;
    const count = this.readings.length;
    const suffix = count > 1 ? ` (mean of ${count})` : '';
    return `${b.sys}/${b.dia} mmHg, central ${c.cSys}/${c.cDia} mmHg${suffix}`;
  }
}

// ── DOM helpers ──────────────────────────────────────────────────────────────
// Scoped to direct children on purpose — see the note at the top of the file.

function firstChildNamed(parent, tag) {
  if (!parent) return null;
  for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
    if (node.nodeName === tag) return node;
  }
  return null;
}

function childrenNamed(parent, tag) {
  const out = [];
  if (!parent) return out;
  for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
    if (node.nodeName === tag) out.push(node);
  }
  return out;
}

function text(el) {
  return el.textContent === null ? '' : el.textContent;
}

function childText(parent, tag) {
  const el = firstChildNamed(parent, tag);
  return el ? text(el) : null;
}

function childNumber(parent, tag) {
  const raw = childText(parent, tag);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Base64 to unsigned 16-bit samples, little-endian — the form every raw
 * pressure recording is transmitted in.
 */
export function decodeUint16Base64(text) {
  let binary;
  try {
    binary = atob(text.trim());
  } catch {
    return new Uint16Array(0);
  }

  const out = new Uint16Array(binary.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
  }
  return out;
}

/** Median of the first n values, used to find the ADC zero. */
function medianOfFirst(values, n) {
  const head = Array.from(values.slice(0, Math.min(n, values.length)));
  if (head.length === 0) return 0;
  head.sort((a, b) => a - b);
  const mid = head.length >> 1;
  return head.length % 2 ? head[mid] : (head[mid - 1] + head[mid]) / 2;
}


// ── Is this result a reading? ────────────────────────────────────────────────

/**
 * Why a result cannot be used as a measurement, or null when it can.
 *
 * A result block is not proof that a determination happened. A run that never
 * completed one — the hose kinked, the device retried, the last attempt aborted
 * on over-pressure — still returns a well-formed block, and it carried zeros in
 * the case this was written for. Anything that asks only whether a field was
 * filled in accepts that.
 *
 * The bounds are the device's own, from `<bpRange>` in the feature list, so
 * this rejects what the hardware says it cannot have measured rather than what
 * looks unlikely. Pass null for `bpRange` and only the checks that need no
 * device knowledge are applied.
 *
 * `<bpRange>` is the BRACHIAL range — what the NIBP module can measure — and is
 * the right bound for the values checked here. Do not narrow it to the ~260
 * mmHg figure that appears elsewhere: that is a different limit, about headroom
 * for the suprasystolic phase rather than about brachial pressure. The cuff has
 * to sit well above systolic to capture the pulse wave — nominally SYS + 35,
 * settling nearer SYS + 40 — so a systolic of 280 would need roughly 320 mmHg
 * of cuff, past the 300 mmHg at which the safety system aborts and dumps.
 *
 * The consequence is two ceilings, not one: this device measures brachial
 * pressure up to and including 280, and above about 260 it will simply fail to
 * produce the suprasystolic rhythm and everything derived from it. A brachial
 * reading of 275 is valid and must not be refused here because the PWA that
 * accompanies it was out of reach.
 *
 * Works on both result shapes: a BpPlusMeasurement and the plain object
 * parseSummaryLine() returns both expose `brachial`.
 *
 * @param {BpPlusMeasurement|object} result
 * @param {{sys, dia, map, hr}|null} [bpRange]  from BpPlusFeatures.bpRange
 * @returns {{code: number, message: string}|null}
 */
export function unusableReason(result, bpRange = null) {
  const bp = result && result.brachial;

  if (!bp || bp.sys === null || bp.sys === undefined ||
             bp.dia === null || bp.dia === undefined) {
    return {
      code: ResultCode.measurementDataInvalid,
      message: 'The device did not return a blood pressure.',
    };
  }

  if (bpRange) {
    const outside = [];
    if (beyondRange(bp.sys, bpRange.sys)) outside.push(`systolic ${bp.sys}`);
    if (beyondRange(bp.dia, bpRange.dia)) outside.push(`diastolic ${bp.dia}`);
    if (bp.pr !== null && bp.pr !== undefined && beyondRange(bp.pr, bpRange.hr)) {
      outside.push(`heart rate ${bp.pr}`);
    }

    if (outside.length) {
      return {
        code: ResultCode.measurementBPOutOfRange,
        message: `The result is outside what this device can measure (${outside.join(', ')}).`,
      };
    }
  }

  // Needs no device knowledge, and no real reading fails it. An aborted run can
  // produce a pair that is individually in range and still is not a pressure.
  if (bp.sys <= bp.dia) {
    return {
      code: ResultCode.measurementDataInvalid,
      message: `The result is not a blood pressure (systolic ${bp.sys} is not above diastolic ${bp.dia}).`,
    };
  }

  return null;
}

/** Outside the device's declared min..max for this value. */
function beyondRange(value, limits) {
  if (!limits || !Number.isFinite(limits.min) || !Number.isFinite(limits.max)) return false;
  return value < limits.min || value > limits.max;
}

/**
 * The alerts in one `<Alert>` element, as `{message, tm2917_hex_result}`.
 *
 * Firmware packs the element as pairs, semicolon separated, with a trailing
 * separator:
 *
 *   Unable to measure BP: Over Pressure (C19);1B0B6843313930412004CB;
 *
 * A measurement that raised several alerts carries several pairs in the same
 * element. The two halves are for different readers and must not be run
 * together: the message is written for a person, and the TM2917 hex result is
 * the module's raw reply, which means nothing to a clinical user and belongs in
 * a log or a support report.
 *
 * @param {string|null} text  the raw <Alert> contents
 * @returns {Array<{message: string, tm2917_hex_result: string|null}>}
 */
export function parseAlerts(text) {
  if (!text) return [];

  const parts = String(text).split(';');
  const alerts = [];

  for (let i = 0; i < parts.length; i += 2) {
    const message = (parts[i] || '').trim();
    if (!message) continue;               // the trailing separator, or padding

    const hex = (parts[i + 1] || '').trim();
    alerts.push({ message, tm2917_hex_result: hex || null });
  }

  return alerts;
}

/**
 * Every alert on a result, in order, without repeats.
 *
 * The NIBP module's own account of what went wrong. It is where the specific
 * cause lives — the Table 5 code that ends a measurement is general — and a
 * failed run still saves and returns a record, so this survives the failure
 * that makes the numbers worthless.
 *
 * @param {BpPlusMeasurement|object} result
 * @returns {Array<{message: string, tm2917_hex_result: string|null}>}
 */
export function alertsOf(result) {
  if (!result) return [];

  const raw = [];
  for (const reading of result.readings || []) {
    if (reading && reading.alert) raw.push(reading.alert);
  }

  // A single (non-AOBP) result carries one Alert of its own rather than a list
  // of readings to hang it on.
  if (!raw.length && typeof result.value === 'function') {
    const single = result.value('Alert');
    if (single) raw.push(single);
  }

  const seen = new Set();
  const alerts = [];

  for (const text of raw) {
    for (const alert of parseAlerts(text)) {
      const key = alert.message + '|' + alert.tm2917_hex_result;
      if (seen.has(key)) continue;
      seen.add(key);
      alerts.push(alert);
    }
  }

  return alerts;
}
