/**
 * The .NET Micro Framework `Utility.ComputeCRC` value — the firmware-update
 * `updateID`, and nothing else in this protocol.
 *
 * CRC-32, polynomial 0x04C11DB7, most-significant-bit first, seeded 0,
 * NOT REFLECTED and with NO FINAL INVERSION.
 *
 * That last line is the whole point of this file. It is *not* the reflected
 * CRC-32 of zip and Ethernet, which is what almost every library hands you by
 * default, and the two agree on no input. Getting it wrong costs a complete
 * upload: the device accumulates its own value from the bytes it received and
 * compares the two only at `v`, which then answers F 50 having taken the
 * entire image first.
 *
 * It chains — the value over a whole file equals the accumulation over its
 * packets in order — so the host does not have to match the device's packet
 * size. `crc32NetMf(whole)` and a fold of `crc32NetMf(packet, running)` give
 * the same answer, which is what `verifyChaining()` asserts.
 */

const POLY = 0x04C11DB7;

// Byte-wise table for the non-reflected polynomial: entry[b] is the CRC
// contribution of a byte entering at the top of the register.
const LUT = (() => {
  const table = new Uint32Array(256);
  for (let b = 0; b < 256; b++) {
    let crc = (b << 24) >>> 0;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80000000)
        ? (((crc << 1) >>> 0) ^ POLY) >>> 0
        : (crc << 1) >>> 0;
    }
    table[b] = crc;
  }
  return table;
})();

/**
 * @param {Uint8Array} bytes
 * @param {number} [seed]  a running value from a previous call; 0 to start
 * @returns {number} an unsigned 32-bit integer
 */
export function crc32NetMf(bytes, seed = 0) {
  let crc = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ LUT[((crc >>> 24) ^ bytes[i]) & 0xFF]) >>> 0;
  }
  return crc >>> 0;
}

/**
 * Self-check, run by the firmware-update tab before it will start a transfer.
 *
 * Asserts the two properties an integrator would otherwise discover the
 * expensive way: that the algorithm is the non-reflected one, and that it
 * chains. The expected value is computed here rather than hard-coded, because
 * the property being checked is the equality, not a magic number.
 *
 * @returns {{ok: boolean, whole: number, chained: number, isReflected: boolean}}
 */
export function verifyChaining() {
  const data = new Uint8Array(1024);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xFF;

  const whole = crc32NetMf(data);

  let chained = 0;
  for (let i = 0; i < data.length; i += 300) {
    chained = crc32NetMf(data.subarray(i, Math.min(i + 300, data.length)), chained);
  }

  // "123456789" is 0xCBF43926 under the reflected CRC-32 everyone else uses.
  // If we ever produce that, the wrong algorithm has been wired in.
  const check = crc32NetMf(new TextEncoder().encode('123456789'));

  return {
    ok: whole === chained && check !== 0xCBF43926,
    whole,
    chained,
    isReflected: check === 0xCBF43926,
  };
}
