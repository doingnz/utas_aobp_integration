/**
 * The feature list — the reply to `f`.
 *
 * Two things here are not obvious from the specification.
 *
 * The closing-tag repair. Devices below feature version 3.0 emit a malformed
 * <nibp_id> element with an opening tag where the closing tag should be:
 *
 *     <nibp_id>5B2800234   <nibp_id>
 *
 * which will not parse. Fixed in BP+ application firmware 5.3.0.0, but any
 * device in the field below that reports it, so the repair is always applied.
 * It is harmless on well-formed XML: the pattern only matches an opening tag
 * that follows the same opening tag with no closing tag between.
 *
 * measureMode is not on every device. It arrives with feature version 3.0;
 * a device that predates it does not report the element at all, and
 * `measureMode` then comes back null. Null means "the device did not say",
 * which is not the same as mode 0 — a host that defaults it will claim the
 * device is in BP+ when it has no idea. Elements are feature-detected
 * throughout rather than inferred from the version attribute.
 */

import { describeMeasureMode, ResultCode } from '../constants.js';
import { crc8Hex } from '../core/crc8.js';
import { BpPlusError } from '../core/errors.js';

/** Elements the repair below knows to look for. Extend rather than generalise. */
const REPAIRABLE_TAGS = ['nibp_id', 'nibpVersion', 'nibpType', 'id', 'fw', 'sw', 'hw'];

/**
 * Repair the malformed closing tags emitted by feature XML below version 3.0.
 * @param {string} xml
 * @returns {{xml: string, repaired: boolean}}
 */
export function repairFeatureXml(xml) {
  let out = xml;
  let repaired = false;

  for (const tag of REPAIRABLE_TAGS) {
    // <tag>value<tag>  →  <tag>value</tag>
    const pattern = new RegExp(`(<${tag}>)([^<]*)<${tag}>`, 'g');
    out = out.replace(pattern, (whole, open, value) => {
      repaired = true;
      return `${open}${value}</${tag}>`;
    });
  }

  return { xml: out, repaired };
}

export class BpPlusFeatures {

  /** @param {string} xml  the raw `<Feature …>` line */
  constructor(xml) {
    this.raw = xml;

    const { xml: repairedXml, repaired } = repairFeatureXml(xml);
    this.wasRepaired = repaired;

    const doc = new DOMParser().parseFromString(repairedXml, 'text/xml');
    const failure = doc.getElementsByTagName('parsererror')[0];
    if (failure) {
      throw new BpPlusError(ResultCode.dataReceivingError, {
        message: 'The device feature list could not be parsed.',
        cause: repairedXml,
      });
    }

    this._root = doc.documentElement;
  }

  /** The schema version attribute. Informational — do not branch on it. */
  get version()  { return this._root.getAttribute('version'); }

  get xmlVersion()     { return this._text('xml'); }
  get firmwareVersion(){ return this._text('fw'); }
  get softwareVersion(){ return this._text('sw'); }
  get hardware()       { return this._text('hw'); }
  get deviceId()       { return this._text('id'); }
  get nibpType()       { return this._text('nibpType'); }
  get nibpVersion()    { return this._text('nibpVersion'); }
  get nibpId()         { return this._text('nibp_id'); }
  get pcbId()          { return this._text('pcb_id'); }
  get themeId()        { return this._text('theme_id'); }
  get filePrefix()     { return this._text('filePrefix'); }

  get filePrefixCount() {
    const raw = this._text('filePrefixCount');
    return raw === null ? null : Number(raw);
  }

  /**
   * The configured measurement mode as an integer, or null when the device
   * did not report one — which is what firmware below the feature list that
   * carries it does, and what a host must be able to say to the user rather
   * than guessing a default.
   *
   * @returns {number|null}
   */
  get measureMode() {
    const raw = this._text('measureMode');
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isInteger(value) ? value : null;
  }

  /** `{mode, label, known}` — label is 'Unknown' when the device did not say. */
  get measureModeInfo() {
    return describeMeasureMode(this.measureMode);
  }

  /** Blood-pressure ranges the NIBP module supports, as `{max, min}` pairs. */
  get bpRange() {
    const block = this._child('bpRange');
    if (!block) return null;

    const pair = tag => {
      const el = childNamed(block, tag);
      if (!el) return null;
      const [max, min] = (el.textContent || '').split(',').map(Number);
      return { max, min };
    };

    return { sys: pair('sys'), dia: pair('dia'), map: pair('map'), hr: pair('hr') };
  }

  /** Everything, as a plain object — handy for a diagnostics panel. */
  toJSON() {
    return {
      version: this.version,
      xmlVersion: this.xmlVersion,
      firmwareVersion: this.firmwareVersion,
      softwareVersion: this.softwareVersion,
      hardware: this.hardware,
      deviceId: this.deviceId,
      nibpType: this.nibpType,
      nibpVersion: this.nibpVersion,
      nibpId: this.nibpId,
      pcbId: this.pcbId,
      themeId: this.themeId,
      measureMode: this.measureMode,
      measureModeLabel: this.measureModeInfo.label,
      filePrefix: this.filePrefix,
      filePrefixCount: this.filePrefixCount,
      bpRange: this.bpRange,
      wasRepaired: this.wasRepaired,
    };
  }

  _child(tag) { return childNamed(this._root, tag); }

  _text(tag) {
    const el = this._child(tag);
    return el ? (el.textContent === null ? '' : el.textContent) : null;
  }
}

function childNamed(parent, tag) {
  for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
    if (node.nodeName === tag) return node;
  }
  return null;
}

// ── The write form ───────────────────────────────────────────────────────────

export const FeatureOption = Object.freeze({
  theme:           'THEME',
  measureMode:     'MEASUREMODE',
  filePrefix:      'FILEPREFIX',
  filePrefixCount: 'FILEPREFIXCOUNT',
});

const MAX_PAIRS = 4;

/**
 * Build an `f` write line.
 *
 *   f <deviceID>,<OPTION>,<value>[,<OPTION>,<value>]...,<crc>
 *
 * The CRC-8 is over the UTF-8 bytes of the device ID followed by every option
 * and value in the order sent, as two upper-case hex digits.
 *
 * An accepted write ALWAYS reboots the device — once, however many settings it
 * carried, and even when the values already match. The reboot is the
 * acknowledgement: there is no success code, and the feature list is not
 * returned. A rejected write answers F 14 and changes nothing, without saying
 * which pair was at fault.
 *
 * @param {string} deviceId  must match the device being addressed
 * @param {Array<[string, string|number]>} pairs
 */
export function buildFeatureWrite(deviceId, pairs) {
  if (!deviceId) {
    throw new BpPlusError(ResultCode.invalidCommand, {
      message: 'A feature write must name the device it is addressed to.',
    });
  }
  if (!Array.isArray(pairs) || pairs.length === 0 || pairs.length > MAX_PAIRS) {
    throw new BpPlusError(ResultCode.invalidCommand, {
      message: `A feature write must carry between 1 and ${MAX_PAIRS} settings.`,
    });
  }

  const seen = new Set();
  const fields = [];

  for (const [option, value] of pairs) {
    if (seen.has(option)) {
      // A repeated option answers F 14 rather than taking the last value.
      throw new BpPlusError(ResultCode.invalidCommand, {
        message: `The setting ${option} was given twice.`,
      });
    }
    seen.add(option);
    fields.push(option, String(value));
  }

  const crc = crc8Hex(deviceId + fields.join(''));
  return `f ${deviceId},${fields.join(',')},${crc}`;
}
