/**
 * Firmware update over the Terminal API — the `w`, `k` and `v` commands.
 *
 *   w <updateID>,<firmwareLength>,<packetSize>   ->  W          | F 50
 *   k <index>,<base64>                           ->  K <index>  | F 50
 *   v                                            ->  M 01, then reboot | F 50
 *   c                                            ->  F 50, session abandoned
 *
 * Three things here are not obvious, and each one costs a whole upload to
 * discover:
 *
 * 1. THE ACKNOWLEDGEMENTS ARE `W` AND `K <index>`. They are not F codes, and
 *    F nn on this path always means the session is over. The two are
 *    deliberately different response types: an F says an action has finished
 *    and nothing more is coming, which is the opposite of what an
 *    acknowledgement says.
 *
 * 2. `F 50` FROM `w` MEANS RESTART, NOT RETRY. It says the device could not
 *    open update storage, which is almost always an earlier transfer still
 *    holding the region — nothing releases it before the next boot. Each
 *    attempt that opens a session and is then abandoned adds another
 *    allocate-and-free cycle, and repeated cycles on a region that already
 *    holds an installed image can hang the device outright: no serial reply,
 *    dead buttons, frozen display, and only a power cycle recovers it. So
 *    this class NEVER retries `w` after F 50.
 *
 * 3. CANCEL BETWEEN PACKETS. A `k` already on the wire when `c` arrives is
 *    still processed; its `K` comes back with nobody waiting, and the device
 *    then answers the orphaned packet with an EXTRA F 50. A button press at
 *    the device cancels too and cannot be timed, so a host must tolerate that
 *    extra F 50 in any case. This is the ONLY place in the protocol where an
 *    unrequested F arrives, which is why the tolerance is armed here rather
 *    than living in the session as a blanket rule.
 *
 * Interrupting is safe. The image is written to a separate flash region, the
 * running application is untouched, and the flag that tells the bootloader to
 * adopt the new image is written only during `v`. The device can be rebooted
 * or power-cycled at any point up to the reboot `v` triggers. An interrupted
 * transfer costs the time spent and nothing else.
 */

import { Emitter } from '../core/emitter.js';
import { ResponseKind } from '../core/responses.js';
import * as commands from '../core/commands.js';
import { crc32NetMf, verifyChaining } from '../core/crc32-netmf.js';
import { BpPlusError } from '../core/errors.js';
import {
  DeviceMode,
  FirmwareUpdateLimits,
  ResultCode,
} from '../constants.js';

export const FirmwareUpdateState = Object.freeze({
  idle:         'idle',
  checking:     'checking',
  opening:      'opening',
  transferring: 'transferring',
  validating:   'validating',
  installing:   'installing',
  cancelling:   'cancelling',
  complete:     'complete',
  failed:       'failed',
  cancelled:    'cancelled',
});


/**
 * Abandoning a session erases the storage it claimed, and that erase does not
 * yield — the whole CLR stops for its duration. Measured at about 0.58 s per
 * 64 KB block, so the wait is derived from the length declared at `w`. A fixed
 * timeout is wrong at both ends: 2.9 s for a 300 KB image, 37 s for a 4 MB one.
 */
const ERASE_MS_PER_64K = 580;
const ERASE_BLOCK_BYTES = 64 * 1024;
const ERASE_MARGIN = 1.5;
const ERASE_FLOOR_MS = 2000;

const OPEN_TIMEOUT_MS    = 20000;
const PACKET_TIMEOUT_MS  = 15000;
const VALIDATE_TIMEOUT_MS = 30000;
const INSTALL_TIMEOUT_MS  = 120000;

export class FirmwareUpdateJob extends Emitter {

  /**
   * @param {import('../core/session.js').Session} session
   * @param {Uint8Array} image  the .nmf contents
   * @param {object} [options]
   * @param {number} [options.packetSize]
   *        512, the only size the device accepts.
   * @param {boolean} [options.requireServiceMenu]
   *        true by default. `w`/`k`/`v` are only accepted from the Service
   *        Menu; anywhere else answers F 14. Checking first turns a confusing
   *        "invalid command" into a sentence saying what to do.
   */
  constructor(session, image, options = {}) {
    super();

    this._session = session;
    this._image   = image;
    this._packetSize = options.packetSize ?? FirmwareUpdateLimits.packetSize;
    this._requireServiceMenu = options.requireServiceMenu !== false;

    this._state = FirmwareUpdateState.idle;
    this._cancelRequested = false;
    this._packetIndex = 0;
    this._bytesSent = 0;
    this._startedAt = 0;

    this._updateId = image && image.length ? crc32NetMf(image) : 0;
    this._packets  = image ? Math.ceil(image.length / this._packetSize) : 0;
  }

  get state()       { return this._state; }
  get updateId()    { return this._updateId; }
  get packetCount() { return this._packets; }
  get imageBytes()  { return this._image ? this._image.length : 0; }
  get packetSize()  { return this._packetSize; }

  /** True once a cancel has been asked for but not yet acted on. */
  get isCancelRequested() { return this._cancelRequested; }

  /**
   * Ask for the transfer to stop.
   *
   * Nothing is sent here. The flag is read by the packet loop, which sends `c`
   * only after a K has been received and before the next k goes out — the one
   * moment at which a cancel leaves the host and the device in step.
   */
  requestCancel() {
    if (this._cancelRequested) return;
    this._cancelRequested = true;
    this._log('Cancel requested — it will be sent after the packet in flight.');
  }

  /**
   * Run the whole update.
   *
   * @returns {Promise<'complete'|'cancelled'>}
   * @throws {BpPlusError} on any failure; the device keeps its old firmware.
   */
  async run() {
    if (this._state !== FirmwareUpdateState.idle) {
      throw new BpPlusError(ResultCode.deviceIsBusy, {
        message: 'This firmware update has already been run.',
      });
    }

    this._startedAt = Date.now();

    try {
      await this._check();
      await this._open();

      const cancelled = await this._transfer();
      if (cancelled) {
        this._setState(FirmwareUpdateState.cancelled);
        return 'cancelled';
      }

      await this._validateAndInstall();
      this._setState(FirmwareUpdateState.complete);
      return 'complete';
    } catch (error) {
      this._setState(FirmwareUpdateState.failed);
      throw error;
    }
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  async _check() {
    this._setState(FirmwareUpdateState.checking);

    if (!this._image || this._image.length === 0) {
      throw this._fail('The firmware file is empty.');
    }
    if (this._image.length > FirmwareUpdateLimits.imageBytesMax) {
      throw this._fail('The firmware file is larger than the 4 MB the device accepts.');
    }

    // The one value in the protocol computed from the file the host actually
    // meant to send, and the only end-to-end integrity check there is. A
    // wrong algorithm fails cleanly at `v`, having taken the whole image
    // first — so it is checked before a byte goes out.
    const chaining = verifyChaining();
    if (!chaining.ok || chaining.isReflected) {
      throw this._fail(
        'The update checksum is not being computed the way the device expects. ' +
        'This is a fault in the software, not in the firmware file.'
      );
    }

    if (this._updateId === 0) {
      // The device requires a non-zero updateID.
      throw this._fail('This firmware file produces a checksum of zero, which the device refuses.');
    }

    this._log(`Image ${this._image.length} bytes, ${this._packets} packets of ` +
              `${this._packetSize}, updateID ${this._updateId}.`);

    if (!this._requireServiceMenu) return;

    const mode = await this._session.request(commands.deviceMode(), {
      accept: r => r.kind === ResponseKind.Mode,
      timeoutMs: 5000,
    });

    if (mode.code !== DeviceMode.serviceMenu) {
      throw new BpPlusError(ResultCode.invalidCommand, {
        message:
          'The BP+ must be in the Service Menu before firmware can be sent, and ' +
          'there is no command that puts it there — an operator has to navigate ' +
          'to it with the buttons on the device.',
      });
    }
  }

  async _open() {
    this._setState(FirmwareUpdateState.opening);

    const line = commands.firmwareUpdateStart(
      this._updateId, this._image.length, this._packetSize
    );

    const reply = await this._session.request(line, {
      accept: r => (r.kind === ResponseKind.Acknowledge && r.letter === 'W') ||
                   r.kind === ResponseKind.Failure,
      acceptFailure: true,
      timeoutMs: OPEN_TIMEOUT_MS,
    });

    if (reply.kind === ResponseKind.Acknowledge) {
      this._log('Update session open.');
      return;
    }

    // F 50 from `w` means restart, not retry. See note 2 at the top.
    if (reply.code === ResultCode.updateFailed) {
      throw new BpPlusError(ResultCode.updateFailed, {
        message:
          'The device could not open its update storage. This is almost always ' +
          'an earlier transfer still holding it, and nothing releases that before ' +
          'the next boot. Restart the BP+, return it to the Service Menu, and send ' +
          'the same update again. Do not retry without restarting.',
      });
    }

    throw new BpPlusError(reply.code, { command: line });
  }

  /**
   * Send every packet, one at a time, each acknowledged before the next.
   * @returns {Promise<boolean>} true when the transfer was cancelled
   */
  async _transfer() {
    this._setState(FirmwareUpdateState.transferring);

    for (this._packetIndex = 0; this._packetIndex < this._packets; this._packetIndex++) {
      // The safe moment: a K has been received and the next k has not gone out.
      if (this._cancelRequested) {
        await this._abandon();
        return true;
      }

      const start = this._packetIndex * this._packetSize;
      const chunk = this._image.subarray(start, Math.min(start + this._packetSize, this._image.length));
      const line  = commands.firmwareUpdatePacket(this._packetIndex, toBase64(chunk));

      const reply = await this._session.request(line, {
        accept: r => (r.kind === ResponseKind.Acknowledge && r.letter === 'K') ||
                     r.kind === ResponseKind.Failure,
        acceptFailure: true,
        timeoutMs: PACKET_TIMEOUT_MS,
      });

      if (reply.kind === ResponseKind.Failure) {
        throw new BpPlusError(reply.code, {
          message: reply.code === ResultCode.updateFailed
            ? `The device rejected packet ${this._packetIndex} and ended the session. ` +
              'Restart the BP+, return it to the Service Menu, and start again.'
            : undefined,
          command: `k ${this._packetIndex}`,
        });
      }

      // K echoes the index it took, so a lost, repeated or reordered packet is
      // caught here rather than as a checksum failure after the whole image.
      if (reply.index !== this._packetIndex) {
        throw this._fail(
          `The device acknowledged packet ${reply.index} when packet ` +
          `${this._packetIndex} was sent. The transfer is out of step and has been stopped.`
        );
      }

      this._bytesSent += chunk.length;
      this._reportProgress();
    }

    return false;
  }

  async _validateAndInstall() {
    this._setState(FirmwareUpdateState.validating);
    this._log('Validating the image on the device…');

    // Armed before `v` is sent: the session drains synchronously, so a watcher
    // registered afterwards can miss the M 02 it is waiting for.
    const restarted = this._watchForRestart();

    let reply;
    try {
      reply = await this._session.request(commands.firmwareUpdateValidate(), {
        accept: r => (r.kind === ResponseKind.Mode && r.code === DeviceMode.offline) ||
                     r.kind === ResponseKind.Failure,
        acceptFailure: true,
        timeoutMs: VALIDATE_TIMEOUT_MS,
      });
    } catch (error) {
      restarted.cancel();
      throw error;
    }

    if (reply.kind === ResponseKind.Failure) {
      restarted.cancel();
      throw new BpPlusError(reply.code, {
        message: reply.code === ResultCode.updateFailed
          ? 'The device rejected the image. Nothing was installed and it is still ' +
            'running its old firmware. This usually means the file did not arrive ' +
            'intact, or is not firmware this device accepts.'
          : undefined,
        command: 'v',
      });
    }

    // M 01 — going off line. On success the install does not return; the
    // device reboots into the new firmware and reports M 00 then M 02.
    this._setState(FirmwareUpdateState.installing);
    this._log('Image accepted. The device is installing it and will restart.');

    await restarted.promise;
    this._log('The device restarted on the new firmware.');
  }

  /**
   * Cancel an open session.
   *
   * One F 50 answers the cancel. One more may follow, from a `k` that was
   * already on the wire and got processed anyway, or from a button press at
   * the device that cannot be timed. The session is armed to swallow exactly
   * one extra before the cancel goes out, so it cannot be mis-read as the
   * answer to whatever the host does next.
   *
   * Then the device answers NOTHING for several seconds while it erases the
   * storage the session claimed, so the wait is sized from the declared
   * length rather than fixed.
   */
  async _abandon() {
    this._setState(FirmwareUpdateState.cancelling);

    const silence = eraseSilenceMs(this._image.length);
    this._log(`Cancelling. The device will be unresponsive for up to ` +
              `${Math.round(silence / 1000)} s while it clears the transfer.`);

    // Armed BEFORE `c` goes out, so it does not matter whether the orphaned
    // packet's F 50 arrives before or after the one that answers the cancel:
    // whichever comes second is the one discarded.
    this._session.expectStrayFailure(ResultCode.updateFailed, silence + 2000);

    try {
      await this._session.request(commands.cancel(), {
        accept: r => r.kind === ResponseKind.Failure,
        acceptFailure: true,
        timeoutMs: silence,
      });
    } catch (error) {
      // The device not answering a cancel is not a failure of the update —
      // the transfer is abandoned either way, and the image was never armed.
      this._log('The device did not acknowledge the cancel. The transfer is ' +
                'abandoned regardless; the device still has its old firmware.');
    }

    this._log('Transfer cancelled. Restart the BP+ before sending another update.');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Resolve when the device is back and ready.
   * Returned rather than awaited so it can be armed before the trigger.
   */
  _watchForRestart() {
    let settle;

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle();
        reject(new BpPlusError(ResultCode.timeoutOrConnectionError, {
          message:
            'The device did not come back within two minutes of starting the ' +
            'install. Nothing is at risk — the old firmware is only replaced once ' +
            'the bootloader has verified the new one. Power-cycle the BP+ and check ' +
            'its version.',
        }));
      }, INSTALL_TIMEOUT_MS);

      // While the device is in reset the state of the serial line is undefined
      // and bytes that do not parse may arrive, including a corrupted M 00.
      // M 02 is the reliable marker.
      const off = this._session.on('mode', mode => {
        if (mode.code !== DeviceMode.ready) return;
        settle();
        resolve(mode);
      });

      settle = () => { clearTimeout(timer); off(); };
    });

    promise.catch(() => {});
    return { promise, cancel: () => settle && settle() };
  }

  _reportProgress() {
    const elapsedMs = Date.now() - this._startedAt;
    const bytesPerSecond = elapsedMs > 0 ? (this._bytesSent / elapsedMs) * 1000 : 0;
    const remaining = this._image.length - this._bytesSent;

    this.emit('progress', {
      phase: this._state,
      packetIndex: this._packetIndex,
      packets: this._packets,
      bytesSent: this._bytesSent,
      bytesTotal: this._image.length,
      percent: Math.round((this._bytesSent / this._image.length) * 100),
      bytesPerSecond,
      secondsRemaining: bytesPerSecond > 0 ? Math.round(remaining / bytesPerSecond) : null,
    });
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this.emit('state', state);
  }

  _log(message) {
    this.emit('log', message);
  }

  _fail(message) {
    return new BpPlusError(ResultCode.updateFailed, { message });
  }
}

/** How long a cancel leaves the device silent, from the declared length. */
export function eraseSilenceMs(imageBytes) {
  const blocks = Math.ceil(imageBytes / ERASE_BLOCK_BYTES);
  return Math.max(ERASE_FLOOR_MS, Math.round(blocks * ERASE_MS_PER_64K * ERASE_MARGIN));
}

/**
 * Base64, because the device parses command lines as UTF-8 text, splits them
 * on commas and frames them on linefeed — raw binary cannot survive that path.
 */
export function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;   // stay well inside the argument limit of apply()
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
