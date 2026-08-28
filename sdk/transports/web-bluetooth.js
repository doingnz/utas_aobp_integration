/**
 * Web Bluetooth transport — a BP+ behind a BLE-to-serial bridge.
 *
 * Five bridge profiles are probed in order after the GATT connection is up,
 * the same set and the same order as the MAUI BleProfileDetector.
 *
 * Device-picker filters
 * ─────────────────────
 * Chrome on Windows (the WinRT stack) does not do active scanning, so a 128-bit
 * service UUID that lives in the scan response is invisible to a services
 * filter. The Nordic bridge puts its UUID there to keep the advertising PDU
 * short. So both are offered: service filters catch adapters that advertise in
 * the ADV PDU, and a name prefix catches the BP+ bridge. Every service UUID is
 * listed in optionalServices so the browser grants access whichever filter
 * matched.
 *
 * Write pacing
 * ────────────
 * Writes are serialised through a single promise chain and each one is
 * awaited. The old code chained `writeValueWithoutResponse` calls with no
 * depth limit, which is fine for `s\r\n` and is not fine for a firmware image:
 * about a thousand packets of ~700 characters, roughly 640 KB, through a
 * bridge that acknowledges nothing. The chunk size is also clamped to what the
 * characteristic will actually take rather than assuming a negotiated MTU.
 */

import { Transport } from './transport.js';

/** Conservative floor — the default ATT MTU of 23 leaves 20 bytes of payload. */
const MIN_CHUNK_BYTES = 20;

export const BLE_PROFILES = Object.freeze([
  {
    name:        'Nordic NUS',
    serviceUuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    writeUuid:   '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    notifyUuid:  '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    configUuid:  null,
    preferNoResponse: true,
    chunkSize:   128,
    buildConfig: null,
  },
  {
    // uConnect S2B5232I BLE-to-RS232 adapter. Needs a four-byte config write:
    //   0: 0xAA  product model (RS-232)
    //   1: 0x07  baud rate 115200
    //   2: 0x00  reserved
    //   3: 0x02  RTS/CTS enabled | 0x00 disabled
    name:        'uConnect S2B5232I',
    serviceUuid: '0003abcd-0000-1000-8000-00805f9b0131',
    writeUuid:   '00031202-0000-1000-8000-00805f9b0130',
    notifyUuid:  '00031201-0000-1000-8000-00805f9b0130',
    configUuid:  '00031203-0000-1000-8000-00805f9b0131',
    preferNoResponse: false,
    chunkSize:   20,
    buildConfig: hardwareFlowControl =>
      new Uint8Array([0xAA, 0x07, 0x00, hardwareFlowControl ? 0x02 : 0x00]),
  },
  {
    name:        'Microchip RN4870',
    serviceUuid: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    writeUuid:   '49535343-1e4d-4bd9-ba61-23c647249616',
    notifyUuid:  '49535343-8841-43f4-a8d4-ecbe34729bb3',
    configUuid:  null,
    preferNoResponse: false,
    chunkSize:   20,
    buildConfig: null,
  },
  {
    name:        'HM-10 / JDY',
    serviceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
    writeUuid:   '0000ffe1-0000-1000-8000-00805f9b34fb',
    notifyUuid:  '0000ffe1-0000-1000-8000-00805f9b34fb',  // bidirectional
    configUuid:  null,
    preferNoResponse: false,
    chunkSize:   20,
    buildConfig: null,
  },
  {
    name:        'HM-10 clone',
    serviceUuid: '0000fff0-0000-1000-8000-00805f9b34fb',
    writeUuid:   '0000fff1-0000-1000-8000-00805f9b34fb',
    notifyUuid:  '0000fff1-0000-1000-8000-00805f9b34fb',  // bidirectional
    configUuid:  null,
    preferNoResponse: false,
    chunkSize:   20,
    buildConfig: null,
  },
]);

export class WebBluetoothTransport extends Transport {

  /**
   * @param {object}  [options]
   * @param {boolean} [options.hardwareFlowControl]
   *        Applies to the uConnect S2B5232I only, which needs a config byte.
   *        The BP+ must have flow control enabled to match. Recommended on
   *        Android, where the BLE link cannot keep up with 115200 baud during
   *        an XML transfer and data is otherwise lost.
   * @param {number}  [options.writeGapMs]
   *        Pause between chunks. 0 is right for a measurement; the firmware
   *        updater raises it if the bridge cannot keep up.
   */
  constructor(options = {}) {
    super('Bluetooth');
    this._hardwareFlowControl = options.hardwareFlowControl !== false;
    this._writeGapMs = options.writeGapMs ?? 0;

    this._device     = null;
    this._profile    = null;
    this._writeChar  = null;
    this._notifyChar = null;
    this._chunkSize  = MIN_CHUNK_BYTES;
    this._writeChain = Promise.resolve();

    this._onGattDisconnect = () => this._dropped('The Bluetooth link dropped.');
    this._onNotify = event => {
      const v = event.target.value;
      this._receive(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    };
  }

  static get isSupported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  get description() {
    if (!this._device) return this.name;
    return `Bluetooth — ${this._device.name || 'unnamed'} (${this._profile ? this._profile.name : 'detecting'})`;
  }

  /** Bytes per GATT write once connected — useful for a throughput estimate. */
  get chunkSize() { return this._chunkSize; }

  async _open() {
    if (!WebBluetoothTransport.isSupported) {
      throw new Error('this browser has no Web Bluetooth API');
    }

    const serviceUuids = BLE_PROFILES.map(p => p.serviceUuid);

    this._device = await navigator.bluetooth.requestDevice({
      filters: [
        ...BLE_PROFILES.map(p => ({ services: [p.serviceUuid] })),
        { namePrefix: 'BP+' },        // the bridge firmware advertises "BP+ Bridge"
        { name: 'NUS Bridge' },       // the ble_nus.c default, kept as a fallback
      ],
      optionalServices: serviceUuids,
    });

    this._device.addEventListener('gattserverdisconnected', this._onGattDisconnect);
    const server = await this._device.gatt.connect();

    const found = await this._detectProfile(server);
    this._profile = found.profile;

    await this._setUpCharacteristics(found.service, found.profile);
  }

  /** Try each known profile's service in priority order. */
  async _detectProfile(server) {
    for (const profile of BLE_PROFILES) {
      try {
        const service = await server.getPrimaryService(profile.serviceUuid);
        return { profile, service };
      } catch {
        // Not this one — getPrimaryService rejects with NotFoundError.
      }
    }
    throw new Error('no known BLE serial profile was found on this device');
  }

  async _setUpCharacteristics(service, profile) {
    this._writeChar = await service.getCharacteristic(profile.writeUuid);

    this._notifyChar = profile.notifyUuid === profile.writeUuid
      ? this._writeChar
      : await service.getCharacteristic(profile.notifyUuid);

    await this._notifyChar.startNotifications();
    this._notifyChar.addEventListener('characteristicvaluechanged', this._onNotify);

    this._chunkSize = this._resolveChunkSize(profile);

    // Serial-port configuration for adapters that need it. Some firmware
    // revisions omit the characteristic, so a missing one is a warning rather
    // than a failure to connect.
    if (profile.configUuid && profile.buildConfig) {
      try {
        const configChar = await service.getCharacteristic(profile.configUuid);
        await configChar.writeValue(profile.buildConfig(this._hardwareFlowControl));
      } catch (err) {
        this.emit('warning', {
          message: `${profile.name}: the configuration characteristic is not available, ` +
                   `so baud rate and flow control were left as the adapter had them (${err.message}).`,
        });
      }
    }
  }

  /**
   * A 128-byte chunk assumes a negotiated ATT MTU of at least 131. Chrome
   * usually gets 517, but the default is 23 and nothing guarantees more.
   *
   * Web Bluetooth exposes no MTU and no maximum write length, so there is
   * nothing to read back — the profile's tested value is the best available
   * answer, floored at the payload the default MTU is certain to carry. If a
   * bridge ever turns out to need less, that is a per-profile change here
   * rather than a guess at call time.
   */
  // eslint-disable-next-line class-methods-use-this
  _resolveChunkSize(profile) {
    return Math.max(MIN_CHUNK_BYTES, profile.chunkSize);
  }

  /**
   * Writes are serialised through one chain, so a caller that does not await
   * still cannot interleave two commands on the wire.
   */
  _write(bytes) {
    this._writeChain = this._writeChain.then(() => this._writeChunks(bytes));
    return this._writeChain;
  }

  async _writeChunks(bytes) {
    const useNoResponse = this._profile.preferNoResponse &&
      typeof this._writeChar.writeValueWithoutResponse === 'function';

    for (let offset = 0; offset < bytes.length; offset += this._chunkSize) {
      const chunk = bytes.slice(offset, offset + this._chunkSize);

      // Awaited either way. writeValueWithoutResponse skips the ATT
      // acknowledgement but still resolves when the chunk has been handed to
      // the controller, which is the backpressure signal we have.
      if (useNoResponse) {
        await this._writeChar.writeValueWithoutResponse(chunk);
      } else {
        await this._writeChar.writeValue(chunk);
      }

      if (this._writeGapMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this._writeGapMs));
      }
    }
  }

  async _close() {
    if (this._notifyChar) {
      this._notifyChar.removeEventListener('characteristicvaluechanged', this._onNotify);
      try { await this._notifyChar.stopNotifications(); } catch { /* already gone */ }
    }
    if (this._device) {
      this._device.removeEventListener('gattserverdisconnected', this._onGattDisconnect);
      if (this._device.gatt.connected) this._device.gatt.disconnect();
    }
    this._device     = null;
    this._profile    = null;
    this._writeChar  = null;
    this._notifyChar = null;
    this._writeChain = Promise.resolve();
  }
}
