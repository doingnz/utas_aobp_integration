/**
 * The one error type the SDK throws.
 *
 * Every failure path — a device `F nn`, a timeout, a CRC mismatch, a rejected
 * parameter — arrives as a BpPlusError carrying the Table 5 code, its firmware
 * name and a sentence a user interface can show without a lookup table of its
 * own. Codes 18..21 are the range Table 5 reserves for host libraries, so a
 * caller can switch on `code` alone and never has to distinguish "the device
 * said no" from "we could not ask".
 */

import { describeResult, ResultCode } from '../constants.js';

export class BpPlusError extends Error {

  /**
   * @param {number}  code     a Table 5 result code
   * @param {object} [options]
   * @param {string} [options.message]  overrides the standard text
   * @param {string} [options.command]  the command line that provoked it
   * @param {*}      [options.cause]
   */
  constructor(code, options = {}) {
    const described = describeResult(code);
    super(options.message || described.text);

    this.name    = 'BpPlusError';
    this.code    = code;
    this.codeName = described.name;
    this.known   = described.known;
    if (options.command) this.command = options.command;
    if (options.cause)   this.cause   = options.cause;
  }

  /** True when the device is temporarily unable rather than refusing outright. */
  get isTransient() {
    return this.code === ResultCode.deviceIsBusy;
  }

  toString() {
    return `${this.name} F ${String(this.code).padStart(2, '0')} (${this.codeName}): ${this.message}`;
  }
}

export function timeoutError(command, ms) {
  return new BpPlusError(ResultCode.timeoutOrConnectionError, {
    message: `The device did not answer "${command}" within ${Math.round(ms / 1000)} s.`,
    command,
  });
}

export function receiveError(message, cause) {
  return new BpPlusError(ResultCode.dataReceivingError, { message, cause });
}

export function connectionError(message, cause) {
  return new BpPlusError(ResultCode.timeoutOrConnectionError, { message, cause });
}
