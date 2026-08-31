/**
 * What to tell the person holding the device.
 *
 * A BpPlusError carries a Table 5 code and a sentence written for a log: it
 * says what happened, in the vocabulary of the protocol. "Could not write to
 * the device." is exact, and leaves whoever is standing at the trolley with
 * nothing to do.
 *
 * This turns a failure into an instruction. It is deliberately not clinical —
 * it talks about cables, ports and power, which are the same for a survey page,
 * a technician's tool and a desktop app. Wording about participants, chairs or
 * records belongs to the application, which can check the reason itself and
 * answer in its own voice before falling back here.
 *
 * The classification comes from `error.reason`, set by the layer that hit the
 * failure. Nothing here reads message text: the same failure is worded
 * differently by every browser, and an instruction that depends on Chrome's
 * phrasing stops being an instruction the day Chrome rewords it.
 */

import { ErrorReason } from './errors.js';
import { ResultCode } from '../constants.js';

const ADVICE = {
  [ErrorReason.portBusy]:
    'The USB cable is in use by something else. Close any other tab or program ' +
    'using the device, then unplug the cable, plug it back in, and try again.',

  [ErrorReason.unplugged]:
    'The USB cable has been unplugged from the computer. Plug it back in, then ' +
    'connect again.',

  [ErrorReason.noAnswer]:
    'The device is not answering. Check the cable is pushed all the way into ' +
    'the device and into the computer, and that the device is switched on, ' +
    'then try again.',

  [ErrorReason.writeFailed]:
    'The device is not answering. Check the cable is pushed all the way into ' +
    'the device and into the computer, and that the device is switched on, ' +
    'then try again.',
};

/**
 * One sentence a user can act on, or null when there is nothing to add.
 *
 * Null rather than a shrug: a caller showing this alongside `error.message`
 * should show nothing when the SDK has nothing useful to say, rather than pad
 * a specific failure with generic advice.
 *
 * @param {Error} error
 * @returns {string|null}
 */
export function adviseOn(error) {
  if (!error) return null;

  if (error.reason && ADVICE[error.reason]) return ADVICE[error.reason];

  // No reason tag, but the code still narrows it: 18 is the connection range,
  // and by here it is not one of the cases a transport could name.
  if (error.code === ResultCode.timeoutOrConnectionError) {
    return ADVICE[ErrorReason.noAnswer];
  }

  return null;
}

/**
 * The whole story for a user: what went wrong, and what to do about it.
 *
 * @param {Error} error
 * @returns {string}
 */
export function describeError(error) {
  if (!error) return 'Something went wrong.';

  const advice = adviseOn(error);

  // The advice replaces the technical sentence rather than following it. Both
  // together reads as an apology with a footnote; the instruction is the part
  // that gets acted on, and the original is still on the error for the log.
  return advice || error.message || String(error);
}
