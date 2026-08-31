/**
 * The transport contract.
 *
 * A transport moves bytes and knows nothing about the BP+ protocol. It exists
 * so the session, the device object and everything above them are identical
 * whether the BP+ is on a serial cable, a USB adapter, a Bluetooth bridge or
 * the simulator.
 *
 * To add your own — a WebSocket to a gateway, a native bridge in a Capacitor
 * shell, a mock in a test — extend this class and implement four things:
 *
 *   async _open()          make the connection; throw on failure
 *   async _close()         tear it down
 *   async _write(bytes)    send; resolve when the bytes are away
 *   emit('data', bytes)    call this._receive(bytes) as they arrive
 *
 * Two rules the session relies on:
 *
 *   - `write` must resolve only when the bytes have actually left, or as close
 *     to it as the underlying API allows. The firmware-update path sends about
 *     a thousand packets back to back, and a write that resolves early turns
 *     into a buffer overrun a long way from its cause.
 *   - `data` may deliver any number of bytes at a time, including a fragment
 *     of a line. The session reassembles; the transport must not try to.
 */

import { Emitter } from '../core/emitter.js';
import { connectionError } from '../core/errors.js';

export const TransportState = Object.freeze({
  disconnected: 'disconnected',
  connecting:   'connecting',
  connected:    'connected',
});

export class Transport extends Emitter {

  constructor(name) {
    super();
    this.name   = name;
    this._state = TransportState.disconnected;
  }

  get state()       { return this._state; }
  get isConnected() { return this._state === TransportState.connected; }

  /** Human-readable description of what is on the other end, once known. */
  get description() { return this.name; }

  async open() {
    if (this._state === TransportState.connected) return;
    this._setState(TransportState.connecting);
    try {
      await this._open();
      this._setState(TransportState.connected);
    } catch (err) {
      // Release whatever _open() managed to acquire before it failed. Opening a
      // serial port is several steps — request the port, open it, take the
      // reader and writer — and a failure at any step after the second leaves
      // the port held by this page. The state then says disconnected, so
      // close() would return without doing anything, and the next attempt meets
      // "The port is already open" from the browser with no way to recover
      // short of a reload.
      try { await this._close(); } catch { /* nothing to release */ }

      this._setState(TransportState.disconnected);
      throw err instanceof Error && err.name === 'BpPlusError'
        ? err
        : connectionError(`Could not connect over ${this.name}: ${err.message}`, err);
    }
  }

  async close() {
    if (this._state === TransportState.disconnected) return;
    try {
      await this._close();
    } finally {
      this._setState(TransportState.disconnected);
    }
  }

  /** @param {Uint8Array} bytes */
  async write(bytes) {
    if (this._state !== TransportState.connected) {
      throw connectionError(`Not connected over ${this.name}.`);
    }
    await this._write(bytes);
  }

  // ── For subclasses ────────────────────────────────────────────────────────

  /** Call as bytes arrive. */
  _receive(bytes) {
    if (bytes && bytes.length) this.emit('data', bytes);
  }

  /** Call when the link drops without close() having been asked for. */
  _dropped(reason) {
    if (this._state === TransportState.disconnected) return;
    this._setState(TransportState.disconnected);
    this.emit('disconnect', reason);
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this.emit('state', state);
  }

  // eslint-disable-next-line class-methods-use-this
  async _open()  { throw new Error('Transport._open() not implemented'); }
  // eslint-disable-next-line class-methods-use-this
  async _close() { /* optional */ }
  // eslint-disable-next-line class-methods-use-this
  async _write() { throw new Error('Transport._write() not implemented'); }
}
