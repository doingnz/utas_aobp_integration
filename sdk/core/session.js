/**
 * The request/response layer — the piece the original bpconnect did not have.
 *
 * Section 2.1: only one command may be outstanding at a time, and
 * notifications (M nn, P nnn) can arrive at any moment, interleaved with
 * command responses. So the inbound stream is split in two:
 *
 *   notifications  emitted as events, whether or not a request is pending
 *   replies        resolve the single request in flight, matched by a
 *                  per-command predicate rather than by "the next line"
 *
 * Requests queue. A caller never has to think about whether the wire is busy.
 *
 * Two behaviours here exist because of the wire, not because of the caller:
 *
 *   The XML block reader. Section 2.6 frames the measurement XML by byte
 *   count, and the firmware suppresses only M nn while sending it — F nn and
 *   P nnn are not suppressed. Reading by count rather than by content means
 *   anything that does arrive afterwards is a line again, not payload.
 *
 *   Stray-failure tolerance, armed explicitly and briefly. A cancel during a
 *   FIRMWARE UPDATE can produce one more F 50 than the host asked for: a `k`
 *   already on the wire when `c` arrives is still processed, its `K` comes
 *   back with nobody waiting, and the device answers the orphaned packet with
 *   an F 50 of its own. A cancel from the device's own buttons cannot be timed
 *   at all, so this has to be tolerated rather than avoided. It is armed by
 *   the firmware-update job around a cancel and by nothing else.
 *
 *   There is NO general duplicate-failure guard, because the device does not
 *   send duplicate failures: a measurement reports its outcome exactly once.
 */

import { Emitter } from './emitter.js';
import { ByteStream, decodeLine } from './byte-stream.js';
import { classify, isNotification, ResponseKind } from './responses.js';
import { crc8 } from './crc8.js';
import { BpPlusError, timeoutError, connectionError } from './errors.js';
import { isFailureCode, ResultCode, describeMode } from '../constants.js';

/** Default window for an explicitly armed stray failure. See expectStrayFailure. */
const STRAY_FAILURE_WINDOW_MS = 5000;

/** Default per-request deadline. Long operations pass their own. */
// Five seconds, not ten. This is how long an operator stands looking at a page
// that says nothing is wrong yet, and a BP+ that is going to answer answers at
// once — the wait only ever elapses in full when the cable is not in the device.
const DEFAULT_TIMEOUT_MS = 5000;

/** Section 2.6 recommends 30 s for a whole XML block. */
const XML_BLOCK_TIMEOUT_MS = 30000;

const CRLF = '\r\n';

export class Session extends Emitter {

  /**
   * @param {object} transport  see transports/transport.js
   */
  constructor(transport) {
    super();
    this._transport = transport;
    this._stream    = new ByteStream();
    this._queue     = [];
    this._pending   = null;
    this._open      = false;

    // XML block reader state — non-null while reading a length-delimited block.
    this._block = null;

    // The reply to `i` is two lines. They are paired here rather than by the
    // caller: the session drains the receive buffer synchronously, so the
    // content line is dispatched before any `await` on the header can resume,
    // and a caller waiting for it would always be too late.
    this._idsHeader = null;

    // Armed by expectStrayFailure(); null the rest of the time.
    this._strayFailure = null;

    this._onBytes      = this._receive.bind(this);
    this._onDisconnect = this._handleDisconnect.bind(this);
  }

  get isOpen() { return this._open; }
  get transport() { return this._transport; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async open() {
    if (this._open) return;

    this._transport.on('data', this._onBytes);
    this._transport.on('disconnect', this._onDisconnect);

    await this._transport.open();

    this._stream.clear();
    this._block = null;
    this._open  = true;
    this.emit('open');
  }

  async close() {
    if (!this._open) return;
    this._open = false;

    this._failAll(connectionError('The connection was closed.'));

    this._transport.off('data', this._onBytes);
    this._transport.off('disconnect', this._onDisconnect);

    try {
      await this._transport.close();
    } finally {
      this.emit('close');
    }
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * Send a command and wait for the reply that ends it.
   *
   * @param {string}   line                 command line, without CRLF
   * @param {object}  [options]
   * @param {(response) => boolean} [options.accept]
   *        true when this response is the reply. Omit for fire-and-forget.
   * @param {boolean} [options.acceptFailure]
   *        by default any F nn other than F 22 / F 99 rejects the request; set
   *        this to have the failure resolve it instead, which `!` and the
   *        firmware-update commands need.
   * @param {number}  [options.timeoutMs]
   * @returns {Promise<object|null>}  the response, or null when no reply is expected
   */
  request(line, options = {}) {
    if (!this._open) {
      return Promise.reject(connectionError('Not connected to a BP+.'));
    }

    return new Promise((resolve, reject) => {
      this._queue.push({
        line,
        accept:        options.accept || null,
        acceptFailure: options.acceptFailure === true,
        timeoutMs:     options.timeoutMs || DEFAULT_TIMEOUT_MS,
        resolve,
        reject,
        timer: null,
      });
      this._pump();
    });
  }

  /**
   * Write a line with no reply expected and no queueing — for `c`, which
   * section 2.1 says is the only command accepted while a measurement runs,
   * and which therefore must not wait behind the measurement in the queue.
   */
  async sendImmediate(line) {
    if (!this._open) throw connectionError('Not connected to a BP+.');
    await this._write(line);
  }

  async _write(line) {
    const text = line + CRLF;
    this.emit('log', { dir: 'tx', text: line, at: Date.now() });
    await this._transport.write(new TextEncoder().encode(text));
  }

  _pump() {
    if (this._pending || this._queue.length === 0 || !this._open) return;

    const request = this._queue.shift();
    this._pending = request;

    if (request.accept) {
      request.timer = setTimeout(() => {
        if (this._pending !== request) return;
        this._pending = null;
        request.reject(timeoutError(request.line, request.timeoutMs));
        this._pump();
      }, request.timeoutMs);
    }

    this._write(request.line).then(() => {
      // Nothing to wait for — resolve as soon as the bytes are away.
      if (!request.accept && this._pending === request) {
        this._pending = null;
        request.resolve(null);
        this._pump();
      }
    }).catch(err => {
      if (this._pending !== request) return;
      this._settle(request, null, connectionError('Could not write to the device.', err));
    });
  }

  _settle(request, value, error) {
    if (request.timer) clearTimeout(request.timer);
    this._pending = null;
    if (error) request.reject(error); else request.resolve(value);
    this._pump();
  }

  _failAll(error) {
    if (this._pending) {
      if (this._pending.timer) clearTimeout(this._pending.timer);
      this._pending.reject(error);
      this._pending = null;
    }
    while (this._queue.length) {
      this._queue.shift().reject(error);
    }
  }

  _handleDisconnect() {
    this._open = false;
    this._failAll(connectionError('The BP+ disconnected.'));
    this.emit('close');
  }

  // ── Receiving ─────────────────────────────────────────────────────────────

  _receive(bytes) {
    this._stream.push(bytes);
    this._drain();
  }

  _drain() {
    for (;;) {
      // A length-delimited XML block takes priority: while one is open the
      // stream is payload, not lines.
      if (this._block) {
        const payload = this._stream.take(this._block.size + 2); // + trailing CRLF
        if (!payload) {
          this._reportBlockProgress();
          return;
        }
        this._completeBlock(payload);
        continue;
      }

      const lineBytes = this._stream.takeLine();
      if (!lineBytes) return;

      const line     = decodeLine(lineBytes);
      const response = classify(line);

      // Checked before the line is logged, so a discarded stray produces ONE
      // trace line saying so rather than a plain line followed by an
      // annotation — which would read as one more failure than the device
      // actually sent.
      const stray = this._isStrayFailure(response);

      this.emit('log', {
        dir:  'rx',
        text: stray ? `${line}   (stray — discarded)` : line,
        at:   Date.now(),
        note: stray ? 'stray' : undefined,
      });

      if (stray) {
        this._strayFailure = null;      // one only
        continue;
      }

      this._dispatch(response);
    }
  }

  _completeBlock(payload) {
    const block = this._block;
    this._block = null;
    clearTimeout(block.timer);

    // The trailing CRLF is framing, not payload.
    const body     = payload.subarray(0, block.size);
    const checksum = crc8(body);
    const xml      = new TextDecoder('utf-8').decode(body);

    const response = {
      kind:  ResponseKind.XmlBlock,
      raw:   `<xml block, ${block.size} bytes>`,
      xml,
      bytes: body,
      size:  block.size,
      crc:   block.crc,
      crcOk: checksum === block.crc,
    };

    if (!response.crcOk) {
      // Section 2.6 leaves this to the host. The reference client surfaces the
      // result flagged rather than discarding it, and so do we — a CRC failure
      // on a measurement that cannot be repeated is worth showing.
      this.emit('warning', {
        message: `Measurement checksum mismatch: expected ${block.crc}, computed ${checksum}.`,
      });
    }

    this._dispatch(response);
  }

  _dispatch(response) {
    // 1. The XML header switches the reader into byte mode.
    if (response.kind === ResponseKind.XmlHeader) {
      this._beginBlock(response);
      return;
    }

    // 1b. The two lines of an IDs frame become one response.
    if (response.kind === ResponseKind.IdsHeader) {
      this._idsHeader = response;
      return;
    }
    if (response.kind === ResponseKind.IdsContent) {
      const header = this._idsHeader;
      this._idsHeader = null;
      response = {
        ...response,
        kind: ResponseKind.IdsFrame,
        declaredLength: header ? header.length : null,
        crc: header ? header.crc : null,
      };
    }

    // 2. Notifications always go out as events. They are NOT consumed by
    //    doing so: `M nn` is sent on every mode change AND is the reply to
    //    `m`, and M 01 is how an accepted `f` write acknowledges itself. So a
    //    notification is emitted and then still offered to a pending request,
    //    whose accept predicate decides whether it was also an answer.
    const notification = isNotification(response);
    if (notification) this._emitNotification(response);

    // 3. Offer it to the request in flight.
    const request = this._pending;
    if (request && request.accept) {
      if (request.accept(response)) {
        this._settle(request, response, null);
        return;
      }
      if (response.kind === ResponseKind.Failure &&
          !request.acceptFailure &&
          isFailureCode(response.code)) {
        this._settle(request, null, new BpPlusError(response.code, { command: request.line }));
        return;
      }
    }

    // A notification that answered nothing is not unsolicited — it is a
    // notification. Only an unmatched reply is worth flagging, and flagging
    // every P nnn would bury it.
    if (!notification) this.emit('unsolicited', response);
  }

  _beginBlock(header) {
    this._block = {
      size: header.size,
      crc:  header.crc,
      timer: setTimeout(() => {
        if (!this._block) return;
        this._block = null;
        this._stream.clear();
        const err = new BpPlusError(ResultCode.dataReceivingTimeout, {
          message: `Only part of the measurement arrived within ${XML_BLOCK_TIMEOUT_MS / 1000} s.`,
        });
        if (this._pending && this._pending.accept) {
          this._settle(this._pending, null, err);
        } else {
          this.emit('error', err);
        }
      }, XML_BLOCK_TIMEOUT_MS),
    };
    this.emit('blockStart', { size: header.size });
    this._reportBlockProgress();
  }

  /**
   * How much of an open block has arrived. Emitted on every inbound chunk that
   * does not complete it, which over BLE is every notification — a 100 KB
   * measurement is thousands of them, and without this the UI shows nothing
   * for the half-minute it takes.
   */
  _reportBlockProgress() {
    if (!this._block) return;
    this.emit('progress', {
      phase: 'receiving',
      bytesReceived: Math.min(this._stream.length, this._block.size),
      bytesTotal: this._block.size,
    });
  }

  _emitNotification(response) {
    switch (response.kind) {
      case ResponseKind.Mode:
        this.emit('mode', describeMode(response.code));
        break;
      case ResponseKind.Pressure:
        this.emit('pressure', response.mmHg);
        break;
      case ResponseKind.Diagnostic:
        // Deprecated and always followed by the F that carries the answer.
        this.emit('diagnostic', response.message);
        break;
      case ResponseKind.Empty:
        // Two of these precede M 00 after any reboot. Not an error (Table 1).
        break;
      default:
        break;
    }
  }

  /**
   * Tolerate ONE unrequested F <code> over the next few seconds.
   *
   * The protocol produces exactly one such case: a cancel during a firmware
   * update, where a packet already on the wire is still processed and the
   * device answers the orphaned packet with an F 50 nobody asked for. A cancel
   * from the device's own buttons cannot be timed, so this cannot be avoided
   * by careful sequencing — it has to be absorbed.
   *
   * Deliberately explicit and deliberately narrow. It is armed by the caller
   * that knows a stray is possible, for one code, for a bounded time, and it
   * swallows one line. It is NOT a general duplicate-failure guard: the device
   * does not send duplicate failures, and a blanket guard would hide a second
   * genuine failure while pretending to be protocol knowledge.
   *
   * @param {number} code
   * @param {number} [windowMs]
   */
  expectStrayFailure(code, windowMs = STRAY_FAILURE_WINDOW_MS) {
    this._strayFailure = { code, until: Date.now() + windowMs };
  }

  /** Cancel an armed tolerance that was never needed. */
  clearStrayFailure() {
    this._strayFailure = null;
  }

  /**
   * True when this line is the stray that was armed for — and only when
   * nothing is actually waiting for it, so the reply to the cancel itself is
   * still delivered normally whichever order the two arrive in.
   */
  _isStrayFailure(response) {
    const armed = this._strayFailure;
    if (!armed) return false;
    if (response.kind !== ResponseKind.Failure) return false;
    if (response.code !== armed.code) return false;
    if (Date.now() > armed.until) {
      this._strayFailure = null;
      return false;
    }
    const pending = this._pending;
    if (pending && pending.accept && pending.accept(response)) return false;
    return true;
  }
}

export { DEFAULT_TIMEOUT_MS, XML_BLOCK_TIMEOUT_MS, STRAY_FAILURE_WINDOW_MS };
