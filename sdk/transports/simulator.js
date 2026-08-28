/**
 * Simulator transport — a scripted BP+ with no hardware.
 *
 * The old simulator replayed one fixed measurement and answered a cancel with
 * M 02, which is not what a device does. This one answers the command set:
 * `?`, `m`, `f`, `d`, `s`, `c`, `q`, `!`, and reproduces the behaviours a host
 * has to cope with and would otherwise only meet in the field:
 *
 *   - the two empty lines and M 00 that precede M 02 after a reboot
 *   - the D <level> echo of the d command
 *   - a cancel answered with one F 02 and one M 02 - the F is NOT duplicated
 *   - a second cancel answered F 22, because the device is back at Ready
 *   - the |_XML_Size header with a real length and a real CRC-8, computed
 *     from the payload rather than hard-coded
 *   - bytes delivered in chunks that split lines, including across the XML
 *
 * `scenario` picks what a measurement does, so the failure paths can be
 * exercised without a device:
 *
 *   'success'   the recorded measurement            (default)
 *   'cancel'    cancels itself part way through
 *   'nibpError' F 11 after the BP phase
 *   'outOfRange' F 13
 *   'busy'      F 17 to any start
 *   'updateStorageBusy'  F 50 to `w`, as an unreleased region does
 *
 * It also answers the firmware-update commands `w`, `k` and `v` — with W and
 * K <index>, which is what the device sends, rather than the F 99 the
 * specification claims.
 * `{ orphanOnCancel: true }` makes a cancel during a transfer produce the
 * orphaned K and the extra F 50 that a real device sends when a packet was
 * already on the wire, or when the operator cancels with the device buttons.
 */

import { Transport } from './transport.js';
import { crc8, crc8Hex } from '../core/crc8.js';
import { crc32NetMf } from '../core/crc32-netmf.js';
import {
  AobpDefaults, AobpLimits, DeviceMode, MeasureMode, ResultCode,
} from '../constants.js';
import {
  MEASUREMENT_XML,
  XML_DECLARATION,
  DATETIME_PLACEHOLDER,
} from './simulator-data.js';

const TICK_MS = 400;
const CHUNK_BYTES = 240;

const DEVICE_ID = '015D90DE1A0000DA';

export class SimulatorTransport extends Transport {

  /**
   * @param {object} [options]
   * @param {string} [options.scenario]     see the note above
   * @param {number} [options.tickMs]       how fast the simulated device runs
   * @param {number} [options.measureMode]  what `f` reports; 5 enables AOBP
   * @param {boolean} [options.reportMeasureMode]
   *        false omits <measureMode> from the feature list, which is what
   *        firmware below the feature list that carries it does — the case a
   *        host has to report as "unknown" rather than assume a default for.
   */
  constructor(options = {}) {
    super('Simulator');
    this.scenario = options.scenario || 'success';
    this._tickMs  = options.tickMs ?? TICK_MS;

    this._measureMode = options.measureMode ?? MeasureMode.bpPlus;
    this._reportMeasureMode = options.reportMeasureMode !== false;

    this._detail  = 0;
    this._mode    = DeviceMode.ready;
    this._timer   = null;
    this._step    = 0;
    this._rx      = '';

    // Set for the duration of an AOBP run.
    this._protocol = null;

    // Whatever the last `s` carried, stored verbatim into <PatientID>.
    this._patientId = '';

    // An open firmware-update session, or null.
    this._update = null;


    // Reproduce a cancel that races a packet: an orphaned K and an extra F 50.
    this._orphanOnCancel = options.orphanOnCancel === true;
  }

  static get isSupported() { return true; }

  get description() { return `Simulator (${this.scenario})`; }

  /**
   * Stand in for an operator walking the device to its Service Menu with the
   * buttons — the only way in, on a real BP+ and therefore here too. Firmware
   * update is refused with F 14 until this has been called.
   */
  enterServiceMenu() {
    this._stopTimer();
    this._setMode(DeviceMode.serviceMenu);
  }

  /** And back out again. */
  leaveServiceMenu() {
    this._update = null;
    this._setMode(DeviceMode.ready);
  }

  async _open() {
    this._mode = DeviceMode.ready;
    // A real device that has just been opened is already up; a host that
    // connects mid-life sees nothing until it asks. Match that.
  }

  async _close() {
    this._stopTimer();
  }

  async _write(bytes) {
    this._rx += new TextDecoder().decode(bytes);

    let index;
    while ((index = this._rx.indexOf('\n')) >= 0) {
      const line = this._rx.slice(0, index).replace(/\r$/, '');
      this._rx = this._rx.slice(index + 1);
      // Answer asynchronously — a device never replies inside the caller's
      // write, and a synchronous answer would hide ordering bugs.
      setTimeout(() => this._handle(line), 0);
    }
  }

  // ── Command handling ──────────────────────────────────────────────────────

  _handle(line) {
    if (line === '') return;

    const letter = line[0];
    const rest   = line.slice(1).trim();

    switch (letter) {
      case '?':
        this._send('ver2.4');
        break;

      case 'm':
        this._sendMode(this._mode);
        break;

      case 'y':
        this._deviceTime(rest);
        break;

      case '!':
        this._send(this._isMeasuring()
          ? `F ${pad(ResultCode.deviceIsBusy)}`
          : `F ${pad(ResultCode.noMeasurementInProgress)}`);
        break;

      case 'd': {
        const level = parseInt(rest, 10);
        if (Number.isFinite(level)) {
          this._detail = level;
          this._send(`D ${level}`);
        } else {
          this._send(`F ${pad(ResultCode.invalidCommand)}`);
        }
        break;
      }

      case 'f':
        if (rest === '') this._send(this._featureXml());
        else             this._featureWrite(rest);
        break;

      case 's':
        this._startMeasurement(rest);
        break;

      case 'c':
        this._cancel();
        break;

      case 'q':
        this._stopTimer();
        setTimeout(() => this._bootSequence(), 400);
        break;

      case 'w':
      case 'k':
      case 'v':
        this._firmwareCommand(letter, rest);
        break;

      default:
        this._send(`F ${pad(ResultCode.invalidCommand)}`);
        break;
    }
  }

  /**
   * The `y` command, in both forms.
   *
   * A set answers by reading the clock back, so a caller gets a timestamp
   * either way and can compare it with what it asked for. Anything that is not
   * exactly fourteen digits is malformed and answers F 24 with no timestamp:
   * a rejected set that ended in a time would be indistinguishable from one
   * that worked.
   */
  /** What this device thinks the time is, including any offset that was set. */
  _deviceNow() {
    return new Date(Date.now() + (this._clockOffsetMs || 0));
  }

  _deviceTime(request) {
    const stamp = String(request || '').trim();

    if (stamp !== '') {
      if (!/^[0-9]{14}$/.test(stamp) || !isRealTimestamp(stamp)) {
        this._send(`F ${pad(ResultCode.invalidDateTime)}`);
        return;
      }
      // Kept as an offset so the clock keeps running from what was set.
      this._clockOffsetMs = timestampToMs(stamp) - Date.now();
    }

    this._send(formatTimestamp(this._deviceNow()));
  }

  /**
   * The `f` write form.
   *
   * Validates the device ID and the CRC-8, applies the setting, and answers
   * with the reboot rather than a success code — exactly as the firmware does.
   * A rejected write answers F 14 and changes nothing, without saying which
   * pair was at fault.
   */
  _featureWrite(message) {
    const fields = message.split(',');

    // deviceID + pairs + crc, so the count is always even.
    const valid = fields.length >= 4 &&
                  fields.length % 2 === 0 &&
                  fields[0] === DEVICE_ID;

    if (!valid) {
      this._send(`F ${pad(ResultCode.invalidCommand)}`);
      return;
    }

    const pairs = fields.slice(1, -1);
    const expected = crc8Hex(DEVICE_ID + pairs.join(''));
    if (fields[fields.length - 1] !== expected) {
      this._send(`F ${pad(ResultCode.invalidCommand)}`);
      return;
    }

    if (this._isMeasuring()) {
      // A write is only accepted while the device is idle.
      this._send(`F ${pad(ResultCode.deviceIsBusy)}`);
      return;
    }

    // Every pair is validated before any is applied.
    const applied = {};
    for (let i = 0; i < pairs.length; i += 2) {
      const option = pairs[i];
      const value  = pairs[i + 1];
      if (option in applied) {
        this._send(`F ${pad(ResultCode.invalidCommand)}`);   // repeated option
        return;
      }
      if (option === 'MEASUREMODE') {
        const mode = Number(value);
        // 2 is reserved and the firmware refuses it.
        if (![0, 1, 3, 4, 5].includes(mode)) {
          this._send(`F ${pad(ResultCode.invalidCommand)}`);
          return;
        }
        applied[option] = mode;
      } else if (option === 'FILEPREFIX' || option === 'FILEPREFIXCOUNT' || option === 'THEME') {
        applied[option] = value;
      } else {
        this._send(`F ${pad(ResultCode.invalidCommand)}`);   // unknown option
        return;
      }
    }

    if ('MEASUREMODE' in applied) this._measureMode = applied.MEASUREMODE;

    // The reboot is the acknowledgement. It happens even when nothing changed.
    this._send(`M ${pad(DeviceMode.offline)}`);
    setTimeout(() => this._bootSequence(), 400);
  }

  _startMeasurement(message) {
    if (this._isMeasuring()) {
      this._send(`F ${pad(ResultCode.deviceIsBusy)}`);
      return;
    }
    if (this.scenario === 'busy') {
      this._send(`F ${pad(ResultCode.deviceIsBusy)}`);
      return;
    }

    const protocol = this._parseStart(message);
    if (protocol === false) {
      this._send(`F ${pad(ResultCode.invalidCommand)}`);
      return;
    }

    // Taken raw, exactly as the firmware does: the device stores whatever is
    // between the commas without trimming, unquoting, escaping or validating
    // it. `s 0, ABC-1` really does store a leading space.
    this._patientId = (message.split(',')[1] ?? '');

    this._protocol = protocol;
    this._step = 0;

    if (protocol) {
      // M 22 while the initial delay counts down, then the normal sequence.
      this._setMode(DeviceMode.countDownAobp);
    }

    this._timer = setInterval(() => this._tick(), this._tickMs);
  }

  /**
   * Parse the AOBP parameters of `s`, applying the firmware's own rules:
   * seated or standing only, the 6th to 8th parameters require the 5th, every
   * value range-checked and REJECTED rather than adjusted, and the whole
   * protocol refused unless the device is configured for AOBP.
   *
   * @returns {object|null|false} the protocol, null for a plain measurement,
   *          or false when the request must be answered F 14
   */
  _parseStart(message) {
    const params = message.split(',');
    const position = (params[4] || '').trim().toLowerCase();
    const initial  = (params[5] || '').trim();
    const repeatDelay = (params[6] || '').trim();
    const repeats  = (params[7] || '').trim();

    const hasQualifier = initial !== '' || repeatDelay !== '' || repeats !== '';

    if (position === '') return hasQualifier ? false : null;

    if (position !== 'seated' && position !== 'standing') return false;
    if (this._measureMode !== MeasureMode.bpPlusAobp) return false;

    const inRange = (raw, limits, fallback) => {
      if (raw === '') return fallback;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < limits.min || value > limits.max) return null;
      return value;
    };

    const defaults = AobpDefaults[position];
    const initialDelaySeconds = inRange(initial, AobpLimits.initialDelaySeconds, defaults.initialDelaySeconds);
    const repeatDelaySeconds  = inRange(repeatDelay, AobpLimits.repeatDelaySeconds, defaults.repeatDelaySeconds);
    const repeatCount         = inRange(repeats, AobpLimits.repeats, defaults.repeats);

    if (initialDelaySeconds === null || repeatDelaySeconds === null || repeatCount === null) {
      return false;
    }

    return {
      bodyPosition: position,
      initialDelaySeconds,
      repeatDelaySeconds,
      repeats: repeatCount,
      // Compressed so a test does not wait five minutes for a rest period.
      restTicks: 2,
      reading: 0,
    };
  }

  /**
   * The firmware-update commands.
   *
   * Answers W and K <index> — NOT F 99, which the specification claims and the
   * firmware never sends. Accepts only from the Service Menu, accumulates its
   * own CRC-32 from the bytes it receives, and compares it against the
   * updateID the host declared only at `v`. A wrong updateID therefore costs
   * the whole transfer and fails cleanly at the end, which is exactly what a
   * host has to be built to survive.
   */
  _firmwareCommand(letter, message) {
    if (this._mode !== DeviceMode.serviceMenu) {
      // Not DeviceUpdateFailed: no update was in progress to fail.
      this._send(`F ${pad(ResultCode.invalidCommand)}`);
      return;
    }

    if (letter === 'w') {
      const [id, length, packetSize] = message.split(',').map(v => Number(v.trim()));
      if (!id || !(length > 0) || packetSize !== 512) {
        this._send(`F ${pad(ResultCode.updateFailed)}`);
        return;
      }
      if (this.scenario === 'updateStorageBusy') {
        // What an earlier transfer still holding the region looks like.
        this._send(`F ${pad(ResultCode.updateFailed)}`);
        return;
      }

      this._update = {
        id, length, packetSize, index: 0, received: 0, crc: 0,
      };
      this._send('W');
      return;
    }

    if (letter === 'k') {
      if (!this._update) {
        this._send(`F ${pad(ResultCode.updateFailed)}`);
        return;
      }

      const comma = message.indexOf(',');
      const index = Number(message.slice(0, comma));
      let bytes;
      try {
        bytes = base64ToBytes(message.slice(comma + 1));
      } catch {
        this._fwFail();
        return;
      }

      // The index must be the one this session expects next, and the length is
      // known before the packet arrives — every packet is packetSize except
      // the last.
      const remaining = this._update.length - this._update.received;
      const expected = Math.min(remaining, this._update.packetSize);
      if (index !== this._update.index || bytes.length !== expected) {
        this._fwFail();
        return;
      }

      this._update.crc = crc32NetMf(bytes, this._update.crc);
      this._update.received += bytes.length;
      this._update.index++;

      this._sendRaw(`K ${index}\r\n`);
      return;
    }

    // v — validate and install.
    if (!this._update) {
      this._send(`F ${pad(ResultCode.updateFailed)}`);
      return;
    }

    const update = this._update;
    this._update = null;

    // A host that stopped early would otherwise install a prefix of the image.
    if (update.received !== update.length || (update.crc >>> 0) !== (update.id >>> 0)) {
      this._send(`F ${pad(ResultCode.updateFailed)}`);
      return;
    }

    this._send(`M ${pad(DeviceMode.offline)}`);
    setTimeout(() => this._bootSequence(), 400);
  }

  /** Report the failure and discard the session, as the firmware does. */
  _fwFail() {
    this._update = null;
    this._send(`F ${pad(ResultCode.updateFailed)}`);
  }

  _cancel() {
    // A cancel during a firmware transfer abandons the session and then leaves
    // the device silent while it erases the storage it claimed.
    if (this._update) {
      const blocks = Math.ceil(this._update.length / 65536);
      const orphan = this._orphanOnCancel;
      this._update = null;
      const wait = Math.min(blocks * 20, 400);   // compressed, but not instant
      setTimeout(() => {
        this._send(`F ${pad(ResultCode.updateFailed)}`);

        // The one place in the protocol where an unrequested F arrives: a
        // packet that was already on the wire is processed anyway, its K comes
        // back with nobody waiting, and the device answers the orphan with an
        // F 50 of its own. A cancel from the device buttons does the same and
        // cannot be timed, so a host has to absorb it.
        if (orphan) {
          this._send('K 99');
          this._send(`F ${pad(ResultCode.updateFailed)}`);
        }
      }, wait);
      return;
    }

    if (!this._isMeasuring()) {
      // Correct behaviour for a second c: the device is back at Ready.
      this._send(`F ${pad(ResultCode.noMeasurementInProgress)}`);
      return;
    }
    this._stopTimer();
    this._protocol = null;
    this._finish(ResultCode.cancelled);
  }

  /**
   * Exactly one F nn, then M 02.
   *
   * A measurement reports its outcome once. It did report twice until
   * A measurement reports its outcome once. Anything modelling a duplicate
   * here would teach an integrator to write a workaround for something the
   * device does not do.
   */
  _finish(code) {
    this._mode = DeviceMode.ready;
    this._send(`F ${pad(code)}`);
    setTimeout(() => this._sendMode(DeviceMode.ready), 30);
  }

  // ── The measurement itself ────────────────────────────────────────────────

  _tick() {
    if (this._protocol) {
      this._tickAobp();
      return;
    }

    const step = this._step++;

    if (step === 0) {
      this._setMode(DeviceMode.measuringBp);
      this._send('P 000');
      return;
    }
    if (step < 9) {
      // Deliberately split a line across two chunks, as a real link does.
      if (step === 2) {
        this._sendRaw('P 020\r\nP 0');
        return;
      }
      if (step === 3) {
        this._sendRaw('30\r\n');
        return;
      }
      this._send(`P ${pad(step * 20, 3)}`);
      return;
    }

    if (step === 9) {
      if (this.scenario === 'nibpError') {
        this._stopTimer();
        this._finish(ResultCode.nibpDeviceError);
        return;
      }
      if (this.scenario === 'outOfRange') {
        this._stopTimer();
        this._finish(ResultCode.measurementBPOutOfRange);
        return;
      }
      if (this.scenario === 'cancel') {
        this._stopTimer();
        this._finish(ResultCode.cancelled);
        return;
      }
      this._setMode(DeviceMode.deflatingCuff);
      this._setMode(DeviceMode.inflatingToSs);
      return;
    }

    if (step === 10) {
      this._setMode(DeviceMode.acquireData);
      return;
    }

    if (step === 11) {
      this._setMode(DeviceMode.processData);
      this._stopTimer();
      this._sendResult();
    }
  }

  /**
   * The AOBP sequence: M 22 while the rest period runs, then one BP reading
   * per repeat (M 03 · P nnn · M 04), then the single suprasystolic capture
   * that follows them, calibrated on the average.
   */
  _tickAobp() {
    const protocol = this._protocol;
    const step = this._step++;

    if (step < protocol.restTicks) return;           // still resting (M 22)

    const perReading = 3;
    const readingStep = step - protocol.restTicks;
    const readingIndex = Math.floor(readingStep / perReading);

    if (readingIndex < protocol.repeats) {
      // One M 03 for the whole sequence, as the device does: between readings
      // it starts the next one without changing mode. The cuff cycle in the
      // pressure stream is the only per-reading signal a host receives.
      switch (readingStep % perReading) {
        case 0:
          if (readingIndex === 0) this._setMode(DeviceMode.measuringBp);
          this._send('P 000');
          break;
        case 1:
          this._send('P 140');
          break;
        default:
          this._send('P 005');
          break;
      }
      return;
    }

    // The readings are done; one suprasystolic capture follows.
    const tail = readingStep - protocol.repeats * perReading;
    switch (tail) {
      case 0:
        this._setMode(DeviceMode.inflatingToSs);
        break;
      case 1:
        this._setMode(DeviceMode.acquireData);
        break;
      default:
        this._setMode(DeviceMode.processData);
        this._stopTimer();
        this._sendResult();
        break;
    }
  }

  _sendResult() {
    if (this._detail === 0) {
      this._send('S 00000 016 122 095 074 044 116 094 075 046 059 072 005 325 160 175 0659');
      this._mode = DeviceMode.ready;
      this._sendMode(DeviceMode.ready);
      return;
    }

    // The device stamps the result from its own clock, in local time. Using
    // toISOString() here put UTC in the XML, which reads as correct anywhere
    // the host happens to sit on UTC and is out by the offset everywhere else.
    // Taking the simulator's clock also means a device whose time was set, or
    // deliberately skewed, says so in the result.
    const stamp = formatXmlStamp(this._deviceNow());
    let xml = MEASUREMENT_XML.replace(DATETIME_PLACEHOLDER, stamp);

    // Written without escaping, as the device does — which is why the SDK
    // refuses < & > before the command goes out rather than after.
    xml = xml.replace('<PatientID></PatientID>',
      `<PatientID>${this._patientId}</PatientID>`);

    if (this._protocol) xml = this._toAobpXml(xml, this._protocol, stamp);

    const body = XML_DECLARATION + xml.replace(/\n/g, '\r\n');

    const payload  = new TextEncoder().encode(body);
    const checksum = crc8(payload);

    this._sendRaw(`|_XML_Size${payload.length} ${checksum}_|\r\n`);
    this._sendBytes(payload);
    this._sendRaw('\r\n');

    this._protocol = null;
    this._mode = DeviceMode.ready;
    this._sendMode(DeviceMode.ready);
  }

  /**
   * Turn the recorded single measurement into the AOBP form.
   *
   * A multi-reading result is version 7.0, carries protocolType, bodyPosition,
   * calculationType and includedMeasurements on <MeasDataLogger>, and adds a
   * <NibpBloodPressures> block with one <NibpBloodPressure> per reading —
   * each with its OWN Sys, Dia, Map and Pr. That last part is the whole reason
   * a host must scope its element lookups: a document-wide search for <Sys>
   * finds the averaged value only because the average is serialised first.
   *
   * The individual readings are derived from the averaged ones so that they
   * average back to them, which is what makes a display that claims to show a
   * mean checkable.
   *
   * The cuff recording moves with them. A single measurement keeps one
   * <RawPressureWave> inside a <PressureWaves> container; a multi-reading
   * protocol records the cuff once per determination, so the wrapper appears
   * inside each <NibpBloodPressure> and the container is not emitted at all. A
   * host that only knows one of the two shapes finds nothing on the other.
   */
  _toAobpXml(xml, protocol, stamp) {
    // Move the recording where a multi-reading result keeps it. The whole
    // <PressureWaves> container goes with it: the device does not emit one
    // when the cuff is recorded per determination.
    const waveStart = xml.indexOf('<RawPressureWave>');
    const waveEnd   = xml.indexOf('</RawPressureWave>');
    const wave = waveStart >= 0 && waveEnd > waveStart
      ? xml.slice(waveStart, waveEnd + '</RawPressureWave>'.length)
      : '';

    const boxStart = xml.indexOf('<PressureWaves>');
    const boxEnd   = xml.indexOf('</PressureWaves>');
    if (boxStart >= 0 && boxEnd > boxStart) {
      xml = xml.slice(0, boxStart) + xml.slice(boxEnd + '</PressureWaves>'.length);
    } else if (wave) {
      xml = xml.replace(wave, '');
    }

    const mean = tag => {
      const match = new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(xml);
      return match ? Number(match[1]) : 0;
    };

    const sys = mean('Sys');
    const dia = mean('Dia');
    const map = mean('Map');
    const pr  = mean('Pr');

    // Offsets that sum to zero, so the readings average to the reported mean.
    const offsets = spreadAroundZero(protocol.repeats);

    const readings = offsets.map((offset, index) => `
      <NibpBloodPressure id="aobp${index + 1}">
        <Sys>${sys + offset}</Sys>
        <Dia>${dia + offset}</Dia>
        <Map>${map + offset}</Map>
        <Pr>${pr - offset}</Pr>
        <IrregularHeartBeat>0</IrregularHeartBeat>
        <MotionDetected>A</MotionDetected>
        <DateTime>${stamp}</DateTime>
        <AobpRequestedDelay>${index === 0 ? protocol.initialDelaySeconds : protocol.repeatDelaySeconds}</AobpRequestedDelay>
        <AobpDelay>${index === 0 ? protocol.initialDelaySeconds : protocol.repeatDelaySeconds}</AobpDelay>
        <Alert>Excellent Signal</Alert>
        ${wave}
      </NibpBloodPressure>`).join('');

    const ids = offsets.map((_, i) => `aobp${i + 1}`).join(',');

    return xml
      .replace('<BPplus version="5.0">', '<BPplus version="7.0">')
      .replace('<MeasDataLogger version="5.0"', '<MeasDataLogger version="7.0"')
      .replace(
        /(<MeasDataLogger [^>]*?)>/,
        `$1 protocolType="aobp" calculationType="mean" ` +
        `bodyPosition="${protocol.bodyPosition}" includedMeasurements="${ids}">`
      )
      .replace('</MeasDataLogger>',
        `  <NibpBloodPressures>${readings}\n      </NibpBloodPressures>\n  </MeasDataLogger>`);
  }

  _featureXml() {
    return '<Feature version="3.0"><xml>1.0</xml>' +
      '<fw>4.4.44094.43303</fw><sw>5.3.0.0</sw><hw>BPplusR7</hw>' +
      `<id>${DEVICE_ID}</id>` +
      '<nibpType>TM2917</nibpType><nibpVersion>101008 :241206:102004 </nibpVersion>' +
      '<nibp_id>5B2800234   </nibp_id>' +
      '<pcb_id>7</pcb_id><theme_id>2</theme_id>' +
      // Omitted entirely when the device does not report one — the case a host
      // must show as "unknown" rather than assume a default for.
      (this._reportMeasureMode ? `<measureMode>${this._measureMode}</measureMode>` : '') +
      '<filePrefix>NONE</filePrefix><filePrefixCount>0</filePrefixCount>' +
      '<bpRange><sys>260,60</sys><dia>200,40</dia><map>220,45</map><hr>200,40</hr></bpRange>' +
      '</Feature>';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _bootSequence() {
    // Table 1: two empty lines terminate whatever partial line the host holds,
    // so M 00 begins on a clean one.
    this._sendRaw('\r\n\r\n');
    this._setMode(DeviceMode.initial);
    setTimeout(() => this._setMode(DeviceMode.ready), 500);
  }

  _isMeasuring() {
    return this._timer !== null;
  }

  _stopTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _setMode(mode) {
    this._mode = mode;
    this._sendMode(mode);
  }

  _sendMode(mode) {
    this._send(`M ${pad(mode)}`);
  }

  _send(line) {
    this._sendRaw(line + '\r\n');
  }

  _sendRaw(text) {
    this._sendBytes(new TextEncoder().encode(text));
  }

  /** Deliver in chunks, so the session's reassembly is genuinely exercised. */
  _sendBytes(bytes) {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      this._receive(bytes.slice(offset, offset + CHUNK_BYTES));
    }
  }
}

/** Base64 back to bytes, so a packet can be checked as the device checks it. */
function base64ToBytes(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function formatXmlStamp(when) {
  const p = n => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}` +
         `T${p(when.getHours())}:${p(when.getMinutes())}:${p(when.getSeconds())}`;
}

function formatTimestamp(when) {
  const p = n => String(n).padStart(2, '0');
  return `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}` +
         `${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
}

function timestampToMs(stamp) {
  const n = (at, len) => Number(stamp.substr(at, len));
  return new Date(n(0, 4), n(4, 2) - 1, n(6, 2), n(8, 2), n(10, 2), n(12, 2)).getTime();
}

function isRealTimestamp(stamp) {
  const when = new Date(timestampToMs(stamp));
  return when.getFullYear() === Number(stamp.substr(0, 4)) &&
         when.getMonth() === Number(stamp.substr(4, 2)) - 1 &&
         when.getDate() === Number(stamp.substr(6, 2));
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** n integers summing to zero, e.g. 3 → [-2, 0, 2] and 4 → [-3, -1, 1, 3]. */
function spreadAroundZero(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(2 * i - (n - 1));
  return out;
}
