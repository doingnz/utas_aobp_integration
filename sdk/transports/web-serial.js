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

    // Must be called from a user gesture — the caller's click handler.
    this._port = await navigator.serial.requestPort(
      this._filters ? { filters: this._filters } : {}
    );

    await this._port.open({
      baudRate:    this._baudRate,
      dataBits:    8,
      stopBits:    1,
      parity:      'none',
      flowControl: this._flowControl,
    });

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

    await settle(this._port && this._port.close(), 2000);

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
function settle(promise, ms) {
  if (!promise || typeof promise.then !== 'function') return Promise.resolve();
  return Promise.race([
    promise.then(() => {}, () => {}),
    new Promise(resolve => setTimeout(resolve, ms)),
  ]);
}

function hex4(n) {
  return n === undefined ? '????' : n.toString(16).padStart(4, '0');
}
