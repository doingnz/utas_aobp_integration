/**
 * WebUSB transport for a USB-to-serial adapter.
 *
 * Android has no Web Serial API, so on an Android phone or tablet this is how a
 * BP+ on a USB cable is reached: WebUSB claims the adapter directly and a chip
 * driver does the vendor-specific setup that Web Serial would otherwise have
 * done in the operating system.
 *
 * This is not a generic serial port: an adapter can only be opened if there is
 * a driver for its chip in `usb-serial-drivers.js`, because every vendor
 * invented its own control protocol. Today that means Prolific PL2303 and
 * nothing else — see that file for what adding another involves.
 *
 * Everything below the driver is chip-agnostic: finding the bulk endpoints,
 * the read loop, writing, and tearing down.
 */

import { Transport } from './transport.js';
import {
  Pl2303Driver,
  USB_SERIAL_DRIVERS,
  allUsbSerialFilters,
} from './usb-serial-drivers.js';

const READ_CHUNK_BYTES = 512;

export class UsbSerialTransport extends Transport {

  /**
   * @param {object}  [options]
   * @param {number}  [options.baudRate]  default 115200
   * @param {object}  [options.driver]    a driver from usb-serial-drivers.js
   * @param {boolean} [options.offerAllDrivers]
   *        Show every known adapter in the chooser rather than only this
   *        driver's. The driver is then picked from what the user selected.
   */
  constructor(options = {}) {
    super(options.driver ? `USB Serial (${options.driver.label})` : 'USB Serial');

    this._baudRate = options.baudRate ?? 115200;
    this._driver   = options.driver ?? Pl2303Driver;
    this._offerAll = options.offerAllDrivers === true;

    this._device      = null;
    this._endpointIn  = null;
    this._endpointOut = null;
    this._interface   = null;
    this._running     = false;
  }

  static get isSupported() {
    return typeof navigator !== 'undefined' && 'usb' in navigator;
  }

  get description() {
    if (!this._device) return this.name;
    const chip = this._driver.describe
      ? this._driver.describe(this._device)
      : this._driver.label;
    return `USB Serial (${chip}) @ ${this._baudRate}`;
  }

  async _open() {
    if (!UsbSerialTransport.isSupported) {
      throw new Error('this browser has no WebUSB API');
    }

    const filters = this._offerAll ? allUsbSerialFilters() : this._driver.filters.slice();
    this._device = await navigator.usb.requestDevice({ filters });

    // With a chooser showing every adapter, what came back decides the driver.
    if (this._offerAll) {
      const matched = matchDriver(this._device);
      if (!matched) {
        throw new Error(
          `no driver for USB device ${hex4(this._device.vendorId)}:` +
          `${hex4(this._device.productId)}`
        );
      }
      this._driver = matched;
    }

    await this._device.open();
    if (this._device.configuration === null) {
      await this._device.selectConfiguration(1);
    }

    this._findEndpoints();
    if (this._endpointIn === null || this._endpointOut === null) {
      throw new Error('the adapter has no bulk endpoints');
    }

    await this._device.claimInterface(this._interface);
    await this._driver.open(this._io(), { baudRate: this._baudRate, device: this._device });

    this._running = true;
    this._read();
  }

  /** The four control-transfer forms a driver may need, and nothing else. */
  _io() {
    const device = this._device;
    return {
      vendorIn: (value, index, length = 1) => device.controlTransferIn({
        requestType: 'vendor', recipient: 'device', request: 0x01, value, index,
      }, length),

      vendorOut: (value, index, data) => device.controlTransferOut({
        requestType: 'vendor', recipient: 'device', request: 0x01, value, index,
      }, data),

      classIn: (request, value, length, index = 0) => device.controlTransferIn({
        requestType: 'class', recipient: 'interface', request, value, index,
      }, length),

      classOut: (request, value, data, index = 0) => device.controlTransferOut({
        requestType: 'class', recipient: 'interface', request, value, index,
      }, data),
    };
  }

  _findEndpoints() {
    const wanted = this._driver.interfaceClass ?? 0xFF;

    for (const iface of this._device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass !== wanted) continue;
        for (const ep of alt.endpoints) {
          if (ep.type !== 'bulk') continue;
          if (ep.direction === 'in')  this._endpointIn  = ep.endpointNumber;
          if (ep.direction === 'out') this._endpointOut = ep.endpointNumber;
        }
        if (this._endpointIn !== null && this._endpointOut !== null) {
          this._interface = iface.interfaceNumber;
          return;
        }
      }
    }
  }

  async _read() {
    while (this._running) {
      let result;
      try {
        result = await this._device.transferIn(this._endpointIn, READ_CHUNK_BYTES);
      } catch (err) {
        if (this._running) this._dropped(`USB read failed: ${err.message}`);
        return;
      }
      if (result.status === 'stall') {
        await this._device.clearHalt('in', this._endpointIn);
        continue;
      }
      if (result.data && result.data.byteLength > 0) {
        this._receive(new Uint8Array(
          result.data.buffer, result.data.byteOffset, result.data.byteLength
        ));
      }
    }
  }

  async _write(bytes) {
    const result = await this._device.transferOut(this._endpointOut, bytes);
    if (result.status !== 'ok') {
      throw new Error(`USB write returned "${result.status}"`);
    }
  }

  async _close() {
    this._running = false;
    if (this._driver.close) {
      try { await this._driver.close(this._io()); } catch { /* already gone */ }
    }
    try { await this._device.releaseInterface(this._interface); } catch { /* already gone */ }
    try { await this._device.close(); } catch { /* already gone */ }
    this._device = null;
  }
}

/**
 * An alias fixed to the Prolific driver.
 *
 * @deprecated Prefer `UsbSerialTransport`, which names what the class is rather
 * than which chip it happens to open.
 */
export class WebUsbPl2303Transport extends UsbSerialTransport {
  constructor(options = {}) {
    super({ ...options, driver: options.driver ?? Pl2303Driver });
  }
}

/** The first driver whose filters match what the chooser returned. */
function matchDriver(device) {
  for (const driver of Object.values(USB_SERIAL_DRIVERS)) {
    for (const filter of driver.filters) {
      const vendorOk  = filter.vendorId === undefined || filter.vendorId === device.vendorId;
      const productOk = filter.productId === undefined || filter.productId === device.productId;
      if (vendorOk && productOk) return driver;
    }
  }
  return null;
}

function hex4(n) {
  return '0x' + Number(n ?? 0).toString(16).padStart(4, '0');
}
