/**
 * Web Serial transport — a BP+ on a serial cable or a USB-to-serial adapter,
 * driven by `navigator.serial`.
 *
 * Requires a secure context (https:// or localhost) and Chrome, Edge or Opera
 * on desktop. Android has no Web Serial — use UsbSerialTransport there, or ask
 * recommendedTransport() which of the two this browser can provide.
 *
 * Port settings per section 2.1: 8N1, RTS/CTS, 115200 by default (older BP+
 * devices come up at 9600 and need `b 115200` sent at 9600 first).
 */

import { Transport } from './transport.js';
import { connectionError, ErrorReason } from '../core/errors.js';

export class WebSerialTransport extends Transport {

  /**
   * @param {object} [options]
   * @param {number} [options.baudRate]     default 115200
   * @param {string} [options.flowControl]  'hardware' (default) or 'none'
   * @param {Array}  [options.filters]      passed to requestPort()
   */
  constructor(options = {}) {
    super('Web Serial');
    this._baudRate    = options.baudRate ?? 115200;
    this._flowControl = options.flowControl === 'none' ? 'none' : 'hardware';
    this._filters     = options.filters || null;

    this._port   = null;
    this._reader = null;
    this._writer = null;
    this._readLoop = null;
    this._onUnplug = null;
    this._unplugged = false;
  }

  static get isSupported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  get description() {
    if (!this._port) return this.name;
    const info = this._port.getInfo ? this._port.getInfo() : {};
    return info.usbVendorId
      ? `Web Serial (USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}) @ ${this._baudRate}`
      : `Web Serial @ ${this._baudRate}`;
  }

  async _open() {
    if (!WebSerialTransport.isSupported) {
      throw new Error('this browser has no Web Serial API');
    }

    this._unplugged = false;

    // Must be called from a user gesture — the caller's click handler.
    this._port = await navigator.serial.requestPort(
      this._filters ? { filters: this._filters } : {}
    );

    const settings = {
      baudRate:    this._baudRate,
      dataBits:    8,
      stopBits:    1,
      parity:      'none',
      flowControl: this._flowControl,
    };

    // A port this page still holds open cannot be opened again. An attempt that
    // failed before teardown finished leaves exactly that, and the handle is
    // ours, so close it before asking for it back. readable and writable are
    // non-null only while the port is open, which makes this cheap to check and
    // safe to skip.
    if (this._port.readable || this._port.writable) {
      this.emit('warning', {
        message: 'The serial port was still open from an earlier attempt. ' +
                 'Closing it and trying again.',
      });
      await settle(this._port.close(), 2000);
    }

    try {
      await this._port.open(settings);
    } catch (err) {
      // One retry, whatever the browser called it. Chrome says "the port is
      // already open" when this page holds it, and the far vaguer "failed to
      // open serial port" when the operating system refuses — which a handle
      // we abandoned will also produce. Closing costs nothing if the port was
      // never open: close() simply rejects and settle() drops it.
      //
      // Never forget() here. It revokes the permission, so the device comes
      // back as a NEW SerialPort object while the old one keeps the operating
      // system handle — turning a recoverable "already open" into a permanent
      // "failed to open", and sending the operator back to the picker for a
      // port they had already granted. That was a bug, not a precaution.
      this.emit('warning', {
        message: 'The serial port would not open (' + err.message + '). ' +
                 'Closing it and trying once more.',
      });

      await settle(this._port.close(), 2000);

      try {
        await this._port.open(settings);
      } catch (retryErr) {
        // Said here rather than left to a caller reading Chrome's wording: this
        // one is not about the cable, and the answer is to find what else has
        // the port. "Failed to open serial port." is the operating system
        // refusing; "already open" is this page still holding it.
        throw connectionError(
          `Could not open the serial port: ${retryErr.message}`,
          retryErr, ErrorReason.portBusy);
      }
    }

    // A port whose cable has been pulled out of the computer is dead, and the
    // SerialPort object does not say so on its own. Callers that hold an open
    // port across a failure — to retry on it rather than reopen it — would
    // otherwise retry for ever against a device that is no longer there.
    this._onUnplug = (event) => {
      // navigator.serial dispatches SerialConnectionEvent, so `target` is
      // navigator.serial and `port` is the port that went away. Matching on
      // target meant the guard never passed and the handler never ran — the
      // cable could be pulled out and nothing said so. The port fires the same
      // event at itself, where there is nothing to match; both are wired, and
      // whichever arrives first wins, because _dropped() only fires once.
      if (event.port && event.port !== this._port) return;
      this._unplugged = true;
      this._dropped('The USB cable was unplugged from the computer.');
    };
    navigator.serial.addEventListener('disconnect', this._onUnplug);
    if (this._port.addEventListener) {
      this._port.addEventListener('disconnect', this._onUnplug);
    }

    this._reader = this._port.readable.getReader();
    this._writer = this._port.writable.getWriter();

    this._readLoop = this._read();
  }

  async _read() {
    try {
      for (;;) {
        const { value, done } = await this._reader.read();
        if (done) break;
        this._receive(value);
      }
    } catch (err) {
      this._dropped(`Web Serial read failed: ${err.message}`);
      return;
    }
    this._dropped('The serial port closed.');
  }

  async _write(bytes) {
    await this._writer.write(bytes);
  }

  /**
   * Give the port back, and never block doing it.
   *
   * Every step here is best-effort and deadlined, because this runs on the path
   * where something has already gone wrong and the caller is waiting to report
   * it. A cleanup that hangs turns a reported failure into a frozen page.
   *
   * `abort()`, not `close()`, on the writer. close() waits for pending writes to
   * drain, and the port is opened with hardware flow control: with a cable in
   * the PC but not in a BP+, nothing asserts CTS, the bytes never leave, and
   * close() waits for ever. Measured exactly that way — a connect that timed out
   * on `f` then hung in its own cleanup, leaving the operator on "Checking the
   * BP+" with every button disabled. abort() discards what could not be sent,
   * which is the right answer for a link being torn down.
   */
  async _close() {
    if (this._onUnplug) {
      navigator.serial.removeEventListener('disconnect', this._onUnplug);
      if (this._port && this._port.removeEventListener) {
        this._port.removeEventListener('disconnect', this._onUnplug);
      }
      this._onUnplug = null;
    }

    // Cancel the reader, then WAIT FOR THE READ LOOP TO END before letting go
    // of the lock. cancel() only makes the pending read() resolve; the loop is
    // still between that and its return, and releaseLock() on a stream the loop
    // still holds throws — swallowed, leaving the lock held and port.close()
    // waiting on it for ever. Measured as a second connect that met "the port
    // is already open" instantly, because the first was never given back.
    await settle(this._reader && this._reader.cancel(), 1000);
    await settle(this._readLoop, 1000);
    try { if (this._reader) this._reader.releaseLock(); } catch { /* already gone */ }

    await settle(this._writer && this._writer.abort(), 1000);
    try { if (this._writer) this._writer.releaseLock(); } catch { /* already gone */ }

    // Not swallowed like the rest. If this fails the port is still held by the
    // page, the next connect will meet "already open", and an operator has no
    // way to know why — so it is said out loud, and _open() knows to recover.
    if (this._port) {
      try {
        await settle(this._port.close(), 2000, true);
      } catch (err) {
        this.emit('warning', {
          message: 'The serial port did not close: ' + err.message +
                   ' The next connect will close it before reopening.',
        });
      }
    }

    this._reader   = null;
    this._writer   = null;
    this._port     = null;
    this._readLoop = null;
  }
}

/**
 * Wait for a teardown step, but not for ever.
 *
 * Resolves when the promise settles either way, or when the deadline passes —
 * a step that never comes back must not hold up the rest of the cleanup.
 */
function settle(promise, ms, rethrow) {
  if (!promise || typeof promise.then !== 'function') return Promise.resolve();
  return Promise.race([
    rethrow ? promise : promise.then(() => {}, () => {}),
    new Promise((resolve, reject) => setTimeout(
      rethrow ? () => reject(new Error('timed out after ' + ms + ' ms')) : resolve, ms)),
  ]);
}

function hex4(n) {
  return n === undefined ? '????' : n.toString(16).padStart(4, '0');
}
