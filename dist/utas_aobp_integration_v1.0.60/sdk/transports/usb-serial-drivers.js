/**
 * Chip drivers for `UsbSerialTransport`.
 *
 * A USB-to-serial adapter is not a standard device. Once the bulk endpoints are
 * found, moving bytes is the same for every chip — but *opening* one is not:
 * each vendor invented its own control-transfer protocol for setting the baud
 * rate and asserting the modem lines, and none of them can be driven by
 * guessing. So the transport owns everything generic and a driver owns the
 * parts that are specific to the silicon.
 *
 * ── Adding another chip ───────────────────────────────────────────────────────
 *
 * Write an object with this shape and add it to `USB_SERIAL_DRIVERS`:
 *
 *   {
 *     id:      'ftdi',                       // key in the registry
 *     label:   'FTDI FT232',                 // shown to a person
 *     filters: [{ vendorId: 0x0403 }],       // passed to requestDevice()
 *     interfaceClass: 0xFF,                  // where the bulk endpoints live
 *     describe(device) { return 'FT232R'; }, // optional, for the UI
 *     async open(io, options) { ... }        // baud rate and modem lines
 *   }
 *
 * `io` gives the driver the four control-transfer forms it can need —
 * `vendorIn`, `vendorOut`, `classIn`, `classOut` — and nothing else, so a
 * driver cannot reach around the transport and start moving data itself.
 *
 * A driver is only ever asked to do what the chip needs. PL2303 happens to take
 * the CDC line-coding requests after its vendor handshake; FTDI has no CDC at
 * all and encodes the baud rate as a divisor in a vendor request, CP210x uses
 * vendor requests 0x00 and 0x1E, CH340 something else again. That is the whole
 * reason this is a driver and not a shared `_setLineCoding()`.
 *
 * Filters matter as much as the setup: `requestDevice()` only offers the user
 * what the filters match, so a chip with no entry here cannot be selected even
 * if the rest would have worked.
 */

/** CDC SET_LINE_CODING — 8N1 at the requested rate. Not all chips accept it. */
function cdcLineCoding(baudRate) {
  const buffer = new ArrayBuffer(7);
  const view   = new DataView(buffer);
  view.setUint32(0, baudRate, true);
  view.setUint8(4, 0);   // 1 stop bit
  view.setUint8(5, 0);   // no parity
  view.setUint8(6, 8);   // 8 data bits
  return buffer;
}

const PROLIFIC_VENDOR_ID = 0x067B;
const PL2303_HX          = 0x2303;
const PL2303_GT          = 0x23A3;

/**
 * Prolific PL2303 — the chip in the cable supplied with the BP+.
 *
 * Covers the original PL2303/PL2303HX (0x2303) and the newer PL2303GT
 * (0x23A3), which needs a different init sequence. The two branches mirror
 * TYPE_01 and TYPE_GT in the Linux pl2303 kernel driver, which is the only
 * published description of the handshake.
 */
export const Pl2303Driver = Object.freeze({
  id:    'pl2303',
  label: 'Prolific PL2303',

  filters: Object.freeze([
    Object.freeze({ vendorId: PROLIFIC_VENDOR_ID, productId: PL2303_HX }),
    Object.freeze({ vendorId: PROLIFIC_VENDOR_ID, productId: PL2303_GT }),
  ]),

  /** The data endpoints are on the vendor-specific interface, not a CDC one. */
  interfaceClass: 0xFF,

  describe(device) {
    return device && device.productId === PL2303_GT ? 'PL2303GT' : 'PL2303';
  },

  async open(io, { baudRate, device }) {
    if (device && device.productId === PL2303_GT) {
      // The GT die does not use the legacy vendor read/write handshake; it
      // needs only a pair of register clears before the CDC line-coding
      // commands.
      await io.vendorOut(0x08, 0);
      await io.vendorOut(0x09, 0);
    } else {
      await io.vendorIn(0x8484, 0);
      await io.vendorOut(0x0404, 0);
      await io.vendorIn(0x8484, 0);
      await io.vendorIn(0x8383, 0);
      await io.vendorIn(0x8484, 0);
      await io.vendorOut(0x0404, 1);
      await io.vendorIn(0x8484, 0);
      await io.vendorIn(0x8383, 0);
      await io.vendorOut(0, 1);
      await io.vendorOut(1, 0);
      await io.vendorOut(2, 0x44);
    }

    await io.classOut(0x20, 0, cdcLineCoding(baudRate));   // SET_LINE_CODING
    await io.classOut(0x22, 0x03);                         // DTR and RTS asserted
  },

  /** Drop the modem lines on the way out, so the far end sees the hang-up. */
  async close(io) {
    await io.classOut(0x22, 0x00);
  },
});

/**
 * Every chip this SDK can open, by id.
 *
 * Only Prolific is here, because it is the only adapter shipped with a BP+ and
 * the only one that has been tested against one. An entry that has never been
 * run against real hardware would be worse than no entry: the device would
 * appear in the chooser and then fail after the user had picked it.
 */
export const USB_SERIAL_DRIVERS = Object.freeze({
  [Pl2303Driver.id]: Pl2303Driver,
});

/** Every filter across every driver, for a chooser that offers all of them. */
export function allUsbSerialFilters() {
  return Object.values(USB_SERIAL_DRIVERS).flatMap(driver => driver.filters.slice());
}
