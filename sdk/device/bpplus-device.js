/**
 * BpPlusDevice — the object an integrator uses.
 *
 * Everything below this is protocol; everything above it is a user interface.
 * Nothing in this file, or anything it imports, touches the DOM, a UI
 * framework or localStorage — so the whole of sdk/ can be dropped into another
 * product without bringing the reference app with it.
 *
 *   const device = new BpPlusDevice(new WebSerialTransport());
 *   device.on('mode',     m  => …);
 *   device.on('pressure', mm => …);
 *   await device.connect();
 *   const result = await device.measure({ patientId: 'TEST-001' });
 *
 * Events
 *   state      'disconnected' | 'connected' | 'measuring'
 *   mode       {code, name, text, known}  — every M nn the device sends
 *   pressure   cuff pressure in mmHg
 *   progress   {phase, ...}  — XML receive, AOBP rest period
 *   log        {dir: 'tx'|'rx', text, at}  — every line, for a trace pane
 *   warning    {message}     — non-fatal, e.g. a checksum mismatch
 *   deviceStarted {mode, cancelling}  — someone pressed Start on the device;
 *                only with hostStartedOnly, see _refuseDeviceStart()
 *   error      BpPlusError   — something failed outside a pending request
 *
 * Failures reject with a BpPlusError carrying the Table 5 code, so a caller
 * switches on `error.code` and never needs a lookup table of its own.
 */

import { Emitter } from '../core/emitter.js';
import { Session } from '../core/session.js';
import { ResponseKind } from '../core/responses.js';
import * as commands from '../core/commands.js';
import { BpPlusError, ErrorReason } from '../core/errors.js';
import {
  AobpDefaults,
  DetailLevel,
  DeviceMode,
  ResultCode,
  describeMode,
  isFailureCode,
} from '../constants.js';
import { BpPlusMeasurement, unusableReason, alertsOf } from './measurement.js';
import { BpPlusFeatures, buildFeatureWrite } from './features.js';
import { FirmwareUpdateJob } from './firmware-update.js';

export const DeviceState = Object.freeze({
  disconnected: 'disconnected',
  connected:    'connected',
  measuring:    'measuring',
});

/** A plain measurement: inflate, deflate, suprasystolic hold, processing. */
const PLAIN_MEASUREMENT_TIMEOUT_MS = 180000;

/** Rough per-reading cost used to size an AOBP deadline. */
const BP_READING_SECONDS = 90;

/** The suprasystolic capture and processing that follow the BP readings. */
const PWA_SECONDS = 180;

/**
 * How long to wait after a result block for the device's verdict on it.
 *
 * The M 02 that ends a measurement follows the result immediately, so a good
 * measurement resolves on that rather than on this timeout. It exists only so a
 * device that never returns to Ready cannot hang the measurement.
 */
const POST_RESULT_GRACE_MS = 2000;

/**
 * Modes that mean a measurement is starting or running on the device.
 *
 * countDownAobp is the AOBP rest period — the trace shows M 22 immediately
 * after `s` — and measuringBp is the cuff on the arm. Either seen while the
 * host is not measuring means somebody pressed Start on the device itself.
 */
const MEASUREMENT_UNDERWAY_MODES = Object.freeze([
  DeviceMode.countDownAobp,
  DeviceMode.measuringBp,
]);

/** Modes that mean the device is back at rest, so an episode has ended. */
const AT_REST_MODES = Object.freeze([DeviceMode.ready, DeviceMode.offline]);

export class BpPlusDevice extends Emitter {

  /**
   * @param {import('../transports/transport.js').Transport} transport
   * @param {object} [options]
   * @param {number} [options.detailLevel]  4 (XML) by default; 0 gives S lines
   * @param {boolean} [options.hostStartedOnly]
   *        cancel any measurement the device starts by itself. Off by default,
   *        because a tool that watches a device should not interfere with it —
   *        but any host that records against a patient ID needs it on. See
   *        _refuseDeviceStart().
   */
  constructor(transport, options = {}) {
    super();

    this._session     = new Session(transport);
    this._state       = DeviceState.disconnected;
    this._detailLevel = options.detailLevel ?? DetailLevel.xml;
    this._lastMode    = null;
    this._features    = null;
    this._awaitingVerdict = false;
    this._hostStartedOnly = options.hostStartedOnly === true;
    this._refusing        = false;

    this._session.on('mode',     m => this._handleMode(m));
    this._session.on('pressure', p => this.emit('pressure', p));
    this._session.on('progress', p => this.emit('progress', p));
    this._session.on('log',      l => this.emit('log', l));
    this._session.on('warning',  w => this.emit('warning', w));
    this._session.on('error',    e => this.emit('error', e));
    this._session.on('diagnostic', message => {
      // Deprecated, and always followed by the F that carries the answer.
      this.emit('log', { dir: 'rx', text: `E "${message}"`, at: Date.now(), note: 'diagnostic' });
    });
    this._session.on('unsolicited', response => {
      // An annotation on the line above, never a repeat of it. The session has
      // already logged every received line, so echoing the raw text here put
      // the same F nn in the trace twice and read as two failures from the
      // device — which is the mistake session.js takes care to avoid for stray
      // failures, for the same reason.
      //
      // "Unsolicited" is the session's word: no *request* was waiting. Once a
      // measurement's verdict is being watched for, that is no longer the whole
      // truth — the F nn that ends a measurement answered nothing and is still
      // the most important line in the trace.
      const isVerdict = this._awaitingVerdict &&
                        response.kind === ResponseKind.Failure;

      this.emit('log', {
        dir: 'rx',
        text: isVerdict
          ? '    ^ the measurement finished with this error'
          : '    ^ unsolicited — nothing was waiting for it',
        at: Date.now(),
        note: isVerdict ? 'verdict' : 'unsolicited',
      });
    });
    this._session.on('close', () => this._setState(DeviceState.disconnected));
  }

  // ── State ─────────────────────────────────────────────────────────────────

  get state()       { return this._state; }
  get isConnected() { return this._state !== DeviceState.disconnected; }
  get isMeasuring() { return this._state === DeviceState.measuring; }
  get transport()   { return this._session.transport; }

  /** The last mode the device reported, or null if it has not said yet. */
  get lastMode()    { return this._lastMode; }

  /** The feature list from the most recent readFeatures(), or null. */
  get features()    { return this._features; }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this.emit('state', state);
  }

  _handleMode(mode) {
    this._lastMode = mode;
    this.emit('mode', mode);
    if (this._hostStartedOnly) this._refuseDeviceStart(mode);
  }

  /**
   * Stop a measurement nobody asked this SDK for.
   *
   * A BP+ has its own Start button, and a measurement begun there carries no
   * patient ID and belongs to no record. The reading is real and the device
   * stores it, so it is not harmless: it is an unattributed measurement in the
   * device's file list that a host cannot match to anyone, and on a study
   * instrument it is a measurement taken outside the protocol.
   *
   * The host's own measurements are excluded by state rather than by timing —
   * measure() sets `measuring` before it sends `s`, so the M 22 and M 03 that
   * follow are already accounted for.
   *
   * Nothing is sent for the AOBP menu itself. There is no measurement to cancel
   * while the operator is still choosing, and `c` would only draw an F 22. The
   * event is emitted so a host can say something before they press Start; the
   * cancel follows if they do.
   */
  _refuseDeviceStart(mode) {
    if (!this.isConnected || this.isMeasuring) return;

    if (AT_REST_MODES.includes(mode.code)) {
      this._refusing = false;             // the episode is over
      return;
    }

    const underway = MEASUREMENT_UNDERWAY_MODES.includes(mode.code);
    if (!underway && mode.code !== DeviceMode.selectAobpMode) return;

    // One refusal per episode: M 23, M 22 and M 03 can arrive in sequence for a
    // single press, and three cancels would be two too many.
    if (this._refusing) return;
    if (underway) this._refusing = true;

    this.emit('deviceStarted', { mode, cancelling: underway });

    if (!underway) return;

    this.cancel().catch(error => {
      this.emit('warning', {
        message: 'A measurement was started on the device and could not be ' +
                 'cancelled: ' + error.message,
      });
    });
  }

  // ── Connection ────────────────────────────────────────────────────────────

  async connect() {
    await this._session.open();
    this._setState(DeviceState.connected);
  }

  async disconnect() {
    await this._session.close();
    // What the device was doing is no longer known, and a stale answer is
    // worse than none — a caller that reconnects must ask again.
    this._lastMode = null;
    this._setState(DeviceState.disconnected);
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /** The Terminal API version, e.g. '2.4'. */
  async readApiVersion() {
    const reply = await this._session.request(commands.apiVersion(), {
      accept: r => r.kind === ResponseKind.ApiVersion,
    });
    return reply.version;
  }

  /** The current device mode. @returns {{code, name, text, known}} */
  async readMode() {
    const reply = await this._session.request(commands.deviceMode(), {
      accept: r => r.kind === ResponseKind.Mode,
    });
    return describeMode(reply.code);
  }

  /**
   * Read the feature list. Also caches it on the device object, because
   * everything that needs to know the measurement mode needs this first.
   * @returns {Promise<BpPlusFeatures>}
   */
  async readFeatures() {
    const reply = await this._session.request(commands.features(), {
      accept: r => r.kind === ResponseKind.Feature,
    });
    this._features = new BpPlusFeatures(reply.xml);
    return this._features;
  }

  /** The device date and time as a yyyyMMddHHmmss string. */
  async readTime() {
    const reply = await this._session.request(commands.getTime(), {
      accept: r => r.kind === ResponseKind.Time,
    });
    return reply.timestamp;
  }

  /**
   * Set the device clock.
   *
   * The device answers a successful set by reading its clock back, so the
   * reply is a timestamp in the same form as `readTime()` and can be compared
   * against what was asked for. A malformed stamp answers F 24 and sends no
   * timestamp at all, which is deliberate on the device's part: a rejected set
   * that ended in a time would read exactly like one that worked.
   *
   * The device keeps local time with no zone, so a Date is written as its
   * local parts.
   *
   * @param {Date|string} [when]  defaults to now
   * @returns {Promise<string>}   the device's clock after the write, yyyyMMddHHmmss
   */
  async writeTime(when = new Date()) {
    const reply = await this._session.request(commands.setTime(when), {
      accept: r => r.kind === ResponseKind.Time,
    });
    return reply.timestamp;
  }

  /**
   * Bring the device clock into line with this computer's, if it has drifted.
   *
   * Reads the clock, and writes only when the difference is beyond the
   * tolerance — a device that is close enough is left alone, so this is cheap
   * enough to call before every measurement. The measurement timestamp is what
   * ends up in the result XML, so a device whose clock is wrong mislabels data
   * that has already been collected.
   *
   * @param {object} [options]
   * @param {number} [options.toleranceMs]  default 5 minutes
   * @param {Date}   [options.now]          the reference time; defaults to now
   * @returns {Promise<{synced: boolean, driftMs: number|null, before: string,
   *                    after: string|null, reason: string}>}
   */
  async syncTime(options = {}) {
    const toleranceMs = options.toleranceMs ?? 5 * 60 * 1000;
    const now = options.now instanceof Date ? options.now : new Date();

    const before = await this.readTime();
    const deviceTime = commands.parseTimestamp(before);

    if (!deviceTime) {
      // Nothing usable to compare against, so the safe move is to set it.
      const after = await this.writeTime(now);
      return {
        synced: true, driftMs: null, before, after,
        reason: 'The device did not report a usable time, so it was set.',
      };
    }

    const driftMs = deviceTime.getTime() - now.getTime();

    if (Math.abs(driftMs) <= toleranceMs) {
      return {
        synced: false, driftMs, before, after: null,
        reason: 'The device clock is within tolerance.',
      };
    }

    const after = await this.writeTime(now);
    return {
      synced: true, driftMs, before, after,
      reason: 'The device clock was out by ' +
              Math.round(Math.abs(driftMs) / 1000) + ' s, so it was set.',
    };
  }

  /**
   * Whether a measurement is running.
   *
   * Answered through F codes: F 22 idle, F 17 running, F 14 from any other
   * screen. All three are the answer, not an error, so failures are accepted
   * here rather than rejected — key off the code, as Table 1 requires.
   */
  async readMeasurementInProgress() {
    const reply = await this._session.request(commands.measurementInProgress(), {
      accept: r => r.kind === ResponseKind.Failure,
      acceptFailure: true,
    });
    return {
      running:   reply.code === ResultCode.deviceIsBusy,
      available: reply.code !== ResultCode.invalidCommand,
      code:      reply.code,
    };
  }

  // ── Measuring ─────────────────────────────────────────────────────────────

  /**
   * Run a measurement and resolve with the result.
   *
   * @param {object}  [options]  see commands.startMeasurement
   * @param {number}  [options.timeoutMs]  computed from the protocol if omitted
   * @returns {Promise<BpPlusMeasurement|object>}
   *          a BpPlusMeasurement at detail level 4, or the parsed S-line fields
   *          at level 0
   */
  async measure(options = {}) {
    // Fresh for each measurement: a cancel remembered from the last one would
    // label the next device-side stop as the operator's own doing.
    this._cancelRequested = false;

    if (this.isMeasuring) {
      throw new BpPlusError(ResultCode.deviceIsBusy, {
        message: 'A measurement is already running.',
      });
    }

    // Built before anything is sent, so a bad parameter is refused locally
    // rather than costing a round trip and an F 14 that does not say which
    // parameter was wrong.
    const line = commands.startMeasurement(options);

    // Table 1: send the detail level immediately before every start, and
    // consume the D echo — on CardioScope 037 and earlier the level resets
    // after every measurement.
    await this._session.request(commands.detail(this._detailLevel), {
      accept: r => r.kind === ResponseKind.DetailEcho,
      timeoutMs: 3000,
    }).catch(err => {
      // Devices that do not echo are documented in Table 1 as an irregularity
      // introduced later; a missing echo is not a reason to refuse to measure.
      if (err.code !== ResultCode.timeoutOrConnectionError) throw err;
      this.emit('warning', {
        message: 'The device did not echo the detail level. Continuing.',
      });
    });

    this._setState(DeviceState.measuring);

    // Armed before the start goes out, so nothing said between the result and
    // M 02 can be missed. See _watchMeasurementOutcome().
    const outcome = this._watchMeasurementOutcome();

    try {
      const reply = await this._session.request(line, {
        accept: r => r.kind === ResponseKind.XmlBlock || r.kind === ResponseKind.Summary,
        timeoutMs: options.timeoutMs || measurementTimeoutMs(options),
      });

      // A result block is not the end of the measurement. The device sends the
      // result, then F nn if the determination actually failed, and then M 02
      // as it returns to Ready. Returning on the result alone reported an
      // over-pressure abort as a good reading.
      const result = reply.kind === ResponseKind.Summary
        ? parseSummaryLine(reply.fields)
        : new BpPlusMeasurement(reply.xml, {
            crcOk: reply.crcOk,
            sizeBytes: reply.size,
          });

      // Built before the verdict is read, because a failed measurement still
      // saves and returns a record, and that record carries the NIBP module's
      // own account of what went wrong. The Table 5 code says only that the
      // module failed; the Alert says it was over-pressure, and which code.
      const failure = await outcome.settle(POST_RESULT_GRACE_MS);
      if (failure) {
        // Attached, not appended to the message. The message names the category
        // for the status line; the alerts are a list a host shows in its own
        // right, and each carries a TM2917 hex result that is for a log rather
        // than for the person holding the cuff.
        throw new BpPlusError(failure.code, {
          command: line,
          alerts: alertsOf(result),
          reason: failure.code === ResultCode.cancelled && this._cancelRequested
            ? ErrorReason.cancelledByHost
            : undefined,
        });
      }

      // A device does not always announce a result it cannot stand behind, so
      // the result is judged as well as the verdict on it. Off by
      // `{ validate: false }` for a caller that wants whatever came back.
      if (options.validate !== false) {
        const unusable = unusableReason(
          result,
          this._features ? this._features.bpRange : null
        );
        if (unusable) {
          throw new BpPlusError(unusable.code, {
            message: unusable.message,
            command: line,
          });
        }
      }

      return result;
    } finally {
      outcome.cancel();
      this._setState(this.isConnected ? DeviceState.connected : DeviceState.disconnected);
    }
  }

  /**
   * Watch for a failure reported after the result block.
   *
   * The device ends a measurement in two parts: the result, then its verdict on
   * it. A cuff that over-pressured sends the XML it managed to collect, then
   * `F 11`, then `M 02` — and `F 11` is what the device's own screen is showing
   * as "Unable to measure BP: Over pressure". A host that returns on the XML
   * has already called the measurement good by the time the verdict arrives.
   *
   * A failure that arrives WHILE the request is in flight already rejects it
   * through the session's normal path. This covers only the window after the
   * result has satisfied the request and before the device is back at Ready.
   */
  _watchMeasurementOutcome() {
    let failure = null;
    let ready = false;
    let wake = null;

    // Read by the unsolicited handler, so an F nn that ends a measurement is
    // labelled as the verdict it is rather than as a stray.
    this._awaitingVerdict = true;

    const offUnsolicited = this._session.on('unsolicited', response => {
      if (response.kind === ResponseKind.Failure && isFailureCode(response.code)) {
        if (!failure) failure = response;
        if (wake) wake();
      }
    });

    const offMode = this._session.on('mode', mode => {
      if (mode.code === DeviceMode.ready) {
        ready = true;
        if (wake) wake();
      }
    });

    return {
      cancel: () => { this._awaitingVerdict = false; offUnsolicited(); offMode(); },

      /**
       * The failure the device reported after the result, or null.
       *
       * Resolves as soon as the device is back at Ready, so a good measurement
       * pays no more than the round trip of the M 02 that follows it.
       */
      settle(timeoutMs) {
        if (failure) return Promise.resolve(failure);

        // Ready is only meaningful from here: the device was at Ready when the
        // measurement was armed, and a mode notification from earlier in the
        // run must not stand in for the one that ends it.
        ready = false;

        return new Promise(resolve => {
          const done = () => { wake = null; clearTimeout(timer); resolve(failure); };
          const timer = setTimeout(done, timeoutMs);
          wake = () => { if (failure || ready) done(); };
        });
      },
    };
  }

  /**
   * Cancel the measurement in progress.
   *
   * Sent immediately rather than queued: `c` is the only command the device
   * accepts while measuring, so it must not wait behind the measurement it is
   * cancelling. The measurement's own promise then rejects with F 02.
   *
   * The device answers a cancel with one F 02 and one M 02.
   */
  async cancel() {
    // Remembered so the measurement can say who stopped it. F 02 is the same
    // code whether the host sent `c` or somebody pressed the button on the
    // device, and those want different words: one is the operator's own action,
    // the other is a thing that happened to them.
    this._cancelRequested = true;
    await this._session.sendImmediate(commands.cancel());
  }

  // ── Recall ────────────────────────────────────────────────────────────────

  /**
   * List stored measurement IDs, most recent first.
   * @param {number} [index] 0 for the most recent 100, then page downwards
   */
  async listMeasurementIds(index = 0) {
    // The reply is two lines; the session pairs them into one IdsFrame.
    const reply = await this._session.request(commands.listMeasurementIds(index), {
      accept: r => r.kind === ResponseKind.IdsFrame,
      timeoutMs: 15000,
    });

    return {
      ids: reply.ids,
      declaredLength: reply.declaredLength,
      crc: reply.crc,
    };
  }

  /**
   * Retrieve a stored measurement.
   *
   * @param {number}  [index]  0 or omitted retrieves the most recent
   * @param {object}  [options]
   * @param {boolean} [options.reprocess]
   *        true (default) reprocesses the stored file, and answers F 09 when
   *        it holds no usable measurement. false uses detail level 5, which
   *        returns the stored XML exactly as held — the way to inspect a file
   *        that will not reprocess.
   */
  async recall(index = 0, options = {}) {
    const reprocess = options.reprocess !== false;
    const level = reprocess ? DetailLevel.xml : DetailLevel.storedXmlNoRework;

    await this._session.request(commands.detail(level), {
      accept: r => r.kind === ResponseKind.DetailEcho,
      timeoutMs: 3000,
    }).catch(() => { /* the echo is optional — see measure() */ });

    const reply = await this._session.request(commands.recallMeasurement(index), {
      accept: r => r.kind === ResponseKind.XmlBlock,
      timeoutMs: 60000,
    });

    return new BpPlusMeasurement(reply.xml, {
      crcOk: reply.crcOk,
      sizeBytes: reply.size,
    });
  }

  // ── Firmware update ───────────────────────────────────────────────────────

  /**
   * Prepare a firmware update. Returns the job WITHOUT starting it, so a
   * caller can subscribe to its events and show the operator what is about to
   * happen — the packet count, the update ID and an estimate — before
   * committing to it.
   *
   *   const job = device.prepareFirmwareUpdate(bytes);
   *   job.on('progress', p => ui.setProgress(p));
   *   await job.run();
   *   job.requestCancel();     // sent between packets, never mid-packet
   *
   * Only accepted while the BP+ is in its Service Menu, which an operator has
   * to reach with the buttons — there is no command for it.
   *
   * @param {Uint8Array} image  the contents of a .nmf file
   * @returns {FirmwareUpdateJob}
   */
  prepareFirmwareUpdate(image, options = {}) {
    return new FirmwareUpdateJob(this._session, image, options);
  }

  // ── Device control ────────────────────────────────────────────────────────

  /**
   * Restart the device.
   *
   * There is no response to the command itself. The device sends two empty
   * lines, then M 00 when its self-test starts, then M 02 when it is ready or
   * M 01 if the self-test failed.
   *
   * @param {object} [options]
   * @param {boolean} [options.waitForReady] resolve only once the device is back
   */
  async reboot(options = {}) {
    if (options.waitForReady === false) {
      await this._session.sendImmediate(commands.reboot());
      return null;
    }

    // Armed before the command goes out. The session drains its receive buffer
    // synchronously, so a watcher registered after an await can miss the very
    // notification it is waiting for.
    const restarted = this._watchForRestart(60000, 'the device to restart');
    try {
      await this._session.sendImmediate(commands.reboot());
      return await restarted.promise;
    } catch (err) {
      restarted.cancel();
      throw err;
    }
  }

  /**
   * Write one or more provisioning settings.
   *
   * An accepted write ALWAYS reboots the device — once, however many settings
   * it carried, and even when the values already match. The reboot is the
   * acknowledgement: there is no success code and the feature list is not
   * returned. A rejected write answers F 14 and changes nothing, without
   * saying which pair was at fault.
   *
   * While the device is resetting the state of the serial line is undefined,
   * so bytes that do not parse may arrive between M 01 and M 02. They are
   * discarded. M 01 and M 02 are the reliable markers.
   *
   * @param {Array<[string, string|number]>} pairs  see FeatureOption
   * @param {object} [options]
   * @param {string} [options.deviceId]  defaults to the cached feature list's
   */
  async writeFeatures(pairs, options = {}) {
    const deviceId = options.deviceId || (this._features && this._features.deviceId);
    if (!deviceId) {
      throw new BpPlusError(ResultCode.invalidCommand, {
        message: 'Read the feature list first — a write must name the device it addresses.',
      });
    }

    const line = buildFeatureWrite(deviceId, pairs);

    // Exactly one outcome line follows: M 01 (accepted, going off line) or
    // F 14 (rejected, nothing changed). M 01 is not a failure here — it is the
    // acknowledgement.
    const accepted = this._session.request(line, {
      accept: r => r.kind === ResponseKind.Mode && r.code === DeviceMode.offline,
      timeoutMs: 10000,
    });

    // The M 01 the write answers with is itself a notification, so the restart
    // watcher has to ignore it and wait for the pair that follows the reboot.
    const restarted = this._watchForRestart(
      60000,
      'the device to restart after the settings were written',
      { skipFirstOffline: true }
    );

    try {
      await accepted;
      await restarted.promise;
    } catch (err) {
      restarted.cancel();
      throw err;
    }

    // The values are only in effect once the device is ready again.
    return this.readFeatures();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Watch for the device coming back after a restart.
   *
   * Returned rather than awaited so the caller can arm it BEFORE sending the
   * command that causes the restart. The session drains its receive buffer
   * synchronously, so a watcher registered after an `await` can miss the very
   * notification it is waiting for.
   *
   * Resolves on M 02, rejects on M 01 — the device came back but failed its
   * self-test, which is a different outcome from never coming back at all.
   *
   * While the device is in reset the state of the serial line is undefined and
   * bytes that do not parse may arrive, including a corrupted M 00. They are
   * ignored: M 01 and M 02 are the reliable markers.
   *
   * @returns {{promise: Promise<object>, cancel: () => void}}
   */
  _watchForRestart(timeoutMs, what, options = {}) {
    let settle;
    let skipOffline = options.skipFirstOffline === true;

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle();
        reject(new BpPlusError(ResultCode.timeoutOrConnectionError, {
          message: `Timed out waiting for ${what}.`,
        }));
      }, timeoutMs);

      const off = this._session.on('mode', mode => {
        if (mode.code === DeviceMode.offline) {
          // The M 01 that acknowledges a feature write, not the restart.
          if (skipOffline) { skipOffline = false; return; }
          settle();
          reject(new BpPlusError(ResultCode.failedSelfTest, {
            message: 'The device restarted but failed its self-test, and is offline.',
          }));
          return;
        }
        if (mode.code !== DeviceMode.ready) return;
        settle();
        resolve(mode);
      });

      settle = () => { clearTimeout(timer); off(); };
    });

    // Nothing must reject unobserved if the caller abandons the wait.
    promise.catch(() => {});

    return { promise, cancel: () => settle && settle() };
  }
}

/**
 * A deadline sized to the protocol that was asked for, because a fixed one is
 * wrong at both ends. The worst legal AOBP run is a 900 s rest period, then
 * five readings 180 s apart, then the suprasystolic capture — about 27
 * minutes, during which the host must not time out.
 */
export function measurementTimeoutMs(options = {}) {
  const aobp = options.aobp;
  if (!aobp) return PLAIN_MEASUREMENT_TIMEOUT_MS;

  const defaults = AobpDefaults[aobp.bodyPosition] || AobpDefaults.seated;
  const initial  = aobp.initialDelaySeconds ?? defaults.initialDelaySeconds;
  const between  = aobp.repeatDelaySeconds  ?? defaults.repeatDelaySeconds;
  const repeats  = aobp.repeats             ?? defaults.repeats;

  const seconds = initial + repeats * (BP_READING_SECONDS + between) + PWA_SECONDS;
  return Math.round(seconds * 1000 * 1.25);   // a quarter over, for slack
}

/**
 * The S line, at detail level 0.
 * S ID SNR Sys Map Dia Pr cSys cMap cDia sPR sPRV sAI sPPV sSEP RWTTpeak RWTTfoot sDpDtMax
 */
export function parseSummaryLine(fields) {
  const n = i => {
    const value = Number(fields[i]);
    return Number.isFinite(value) ? value : null;
  };
  return {
    isSummary: true,
    id:  n(0),
    snr: n(1),
    brachial: { sys: n(2), map: n(3), dia: n(4), pr: n(5) },
    central:  { cSys: n(6), cMap: n(7), cDia: n(8) },
    indices: {
      sPR: n(9), sPRV: n(10), sAI: n(11), sPPV: n(12), sSEP: n(13),
      sRWTTPeak: n(14), sRWTTFoot: n(15), sDpDtMax: n(16),
    },
    fields,
  };
}
