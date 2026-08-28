/**
 * The receive buffer.
 *
 * Holds raw bytes and hands them back one of two ways, because the protocol
 * needs both:
 *
 *   takeLine()   — up to and including the next LF, with a trailing CR
 *                  stripped, for the ASCII line protocol
 *   take(n)      — exactly n bytes, for the measurement XML block, which
 *                  section 2.6 frames by byte count and which contains its own
 *                  line breaks
 *
 * Bytes, not a string. Decoding byte-by-byte with String.fromCharCode gives
 * Latin-1, and the payload is UTF-8 — the CRC and the length would still agree
 * while the parsed text was quietly wrong for any non-ASCII character.
 *
 * The buffer compacts in place and grows by doubling. A measurement XML block
 * runs past 100 KB, so this is on the hot path.
 */
export class ByteStream {

  constructor(initialCapacity = 16 * 1024) {
    this._buf   = new Uint8Array(initialCapacity);
    this._start = 0;
    this._end   = 0;
  }

  get length() {
    return this._end - this._start;
  }

  clear() {
    this._start = 0;
    this._end   = 0;
  }

  /** @param {Uint8Array} bytes */
  push(bytes) {
    if (!bytes || bytes.length === 0) return;

    const needed = this.length + bytes.length;

    if (needed > this._buf.length) {
      let capacity = this._buf.length;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this._buf.subarray(this._start, this._end));
      this._buf  = grown;
      this._end -= this._start;
      this._start = 0;
    } else if (this._end + bytes.length > this._buf.length) {
      // Room overall, just not at the tail — slide what is left to the front.
      this._buf.copyWithin(0, this._start, this._end);
      this._end  -= this._start;
      this._start = 0;
    }

    this._buf.set(bytes, this._end);
    this._end += bytes.length;
  }

  /**
   * Exactly n bytes, or null when fewer are buffered.
   * @returns {Uint8Array|null}
   */
  take(n) {
    if (n < 0 || this.length < n) return null;
    const out = this._buf.slice(this._start, this._start + n);
    this._start += n;
    return out;
  }

  /**
   * The next complete line, with the LF consumed and a trailing CR removed.
   * An empty line yields a zero-length array, which is not an error: the
   * device sends two at start-up to terminate whatever partial line the host
   * may be holding (Table 1).
   *
   * @returns {Uint8Array|null} null when no complete line is buffered yet
   */
  takeLine() {
    for (let i = this._start; i < this._end; i++) {
      if (this._buf[i] !== 0x0A) continue;

      let stop = i;
      if (stop > this._start && this._buf[stop - 1] === 0x0D) stop--;

      const out = this._buf.slice(this._start, stop);
      this._start = i + 1;
      return out;
    }
    return null;
  }

  /** Everything buffered, without consuming it. For diagnostics only. */
  peek() {
    return this._buf.subarray(this._start, this._end);
  }
}

const ASCII_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * Decode one protocol line. Command lines are ASCII by definition, but a
 * deprecated `E "message"` may be translated into the device's language, so
 * this decodes as UTF-8 rather than assuming.
 */
export function decodeLine(bytes) {
  return ASCII_DECODER.decode(bytes);
}
