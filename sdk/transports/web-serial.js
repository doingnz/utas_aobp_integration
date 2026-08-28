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

  async _close() {
    // Cancel the reader first so the read loop ends before the port closes;
    // closing underneath an active reader throws in some Chrome versions.
    try { if (this._reader) await this._reader.cancel(); } catch { /* already gone */ }
    try { if (this._reader) this._reader.releaseLock(); } catch { /* already gone */ }
    try { if (this._writer) await this._writer.close(); } catch { /* already gone */ }
    try { if (this._writer) this._writer.releaseLock(); } catch { /* already gone */ }
    try { if (this._port)   await this._port.close(); } catch { /* already gone */ }

    this._reader = null;
    this._writer = null;
    this._port   = null;
  }
}

function hex4(n) {
  return n === undefined ? '????' : n.toString(16).padStart(4, '0');
}
