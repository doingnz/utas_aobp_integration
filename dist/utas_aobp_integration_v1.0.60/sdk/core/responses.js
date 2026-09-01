/**
 * Turn one received line into a typed response.
 *
 * Order matters, and it is the order Table 1 requires. Three replies carry no
 * type letter and MUST be recognised by prefix before single-letter dispatch:
 *
 *   ver...                      reply to ?
 *   <Feature...                 reply to f
 *   IDs_H... / IDs_Content...   reply to i
 *
 * The feature list is the one that bites: it begins with '<', so any parser
 * that tests for a leading angle bracket to find the start of a measurement
 * XML block will swallow the reply to `f` and then wait forever for a closing
 * tag that never comes. That is why nothing here looks at '<' at all — the XML
 * block is found by its `|_XML_Size` header and then read by byte count.
 */

export const ResponseKind = Object.freeze({
  Empty:       'empty',
  Mode:        'mode',
  Pressure:    'pressure',
  Failure:     'failure',
  Summary:     'summary',
  DetailEcho:  'detailEcho',
  ApiVersion:  'apiVersion',
  Feature:     'feature',
  IdsHeader:   'idsHeader',
  IdsContent:  'idsContent',
  // The two lines above, paired by the session into one reply to `i`.
  IdsFrame:    'idsFrame',
  XmlHeader:   'xmlHeader',
  XmlBlock:    'xmlBlock',
  Time:        'time',
  Acknowledge: 'acknowledge',
  Diagnostic:  'diagnostic',
  Unknown:     'unknown',
});

const RE_XML_HEADER  = /^\|_XML_Size(\d+)\s+(\d+)_\|$/;
const RE_BARE_TIME   = /^\d{14}$/;
const RE_T_TIME      = /^T\s+(\d{14})/;
const RE_IDS_HEADER  = /^IDs_H\s+(\d+)\s+(\d+)/;
const RE_DIAGNOSTIC  = /^E\s+"?(.*?)"?\s*$/;

/**
 * @param {string} line  one received line, CR and LF already stripped
 * @returns {{kind: string, raw: string, [key: string]: *}}
 */
export function classify(line) {
  const raw     = line;
  const trimmed = line.trim();

  if (trimmed === '') {
    return { kind: ResponseKind.Empty, raw };
  }

  // ── Unprefixed replies, before anything else ──────────────────────────────

  const xmlHeader = RE_XML_HEADER.exec(trimmed);
  if (xmlHeader) {
    return {
      kind: ResponseKind.XmlHeader,
      raw,
      size: parseInt(xmlHeader[1], 10),
      crc:  parseInt(xmlHeader[2], 10),   // decimal, not hex
    };
  }

  if (trimmed.startsWith('ver')) {
    return { kind: ResponseKind.ApiVersion, raw, version: trimmed.slice(3).trim() };
  }

  if (trimmed.startsWith('<Feature')) {
    return { kind: ResponseKind.Feature, raw, xml: trimmed };
  }

  const idsHeader = RE_IDS_HEADER.exec(trimmed);
  if (idsHeader) {
    return {
      kind: ResponseKind.IdsHeader,
      raw,
      length: parseInt(idsHeader[1], 10),
      crc:    parseInt(idsHeader[2], 10),
    };
  }

  if (trimmed.startsWith('IDs_Content')) {
    const ids = trimmed.slice('IDs_Content'.length).trim();
    return {
      kind: ResponseKind.IdsContent,
      raw,
      ids: ids === '' ? [] : ids.split(/\s+/).map(Number).filter(n => Number.isFinite(n)),
    };
  }

  // A bare 14-digit line is the reply to `y`. Some legacy devices answer
  // "T <yyyyMMddHHmmss>" instead; Table 1 says accept both.
  if (RE_BARE_TIME.test(trimmed)) {
    return { kind: ResponseKind.Time, raw, timestamp: trimmed };
  }
  const tTime = RE_T_TIME.exec(trimmed);
  if (tTime) {
    return { kind: ResponseKind.Time, raw, timestamp: tTime[1] };
  }

  // ── Single-letter dispatch ────────────────────────────────────────────────

  const letter = trimmed[0];
  const rest   = trimmed.slice(1).trim();

  switch (letter) {
    case 'M': {
      const code = parseInt(rest, 10);
      if (Number.isFinite(code)) return { kind: ResponseKind.Mode, raw, code };
      break;
    }

    case 'P': {
      const mmHg = parseInt(rest, 10);
      if (Number.isFinite(mmHg)) return { kind: ResponseKind.Pressure, raw, mmHg };
      break;
    }

    case 'F': {
      const code = parseInt(rest, 10);
      if (Number.isFinite(code)) return { kind: ResponseKind.Failure, raw, code };
      break;
    }

    case 'D': {
      const level = parseInt(rest, 10);
      if (Number.isFinite(level)) return { kind: ResponseKind.DetailEcho, raw, level };
      break;
    }

    case 'S': {
      // S ID SNR Sys Map Dia Pr cSys cMap cDia sPR sPRV sAI sPPV sSEP
      //   RWTTpeak RWTTfoot sDpDtMax
      const fields = rest.split(/\s+/);
      if (fields.length > 1) {
        return { kind: ResponseKind.Summary, raw, fields };
      }
      break;
    }

    // W acknowledges `w` and takes no parameter; K acknowledges `k` and echoes
    // the packet index it took. Deliberately separate response types from
    // F nn: an F says an action has finished and nothing more is coming, which
    // is the opposite of what an acknowledgement says.
    case 'W':
      if (rest === '') return { kind: ResponseKind.Acknowledge, raw, letter: 'W' };
      break;

    case 'K': {
      const index = parseInt(rest, 10);
      if (Number.isFinite(index)) {
        return { kind: ResponseKind.Acknowledge, raw, letter: 'K', index };
      }
      break;
    }

    // Deprecated. Not emitted by BP+ 2.0 or later; CardioScope and BP+ 1.x
    // devices send it, always followed by the F that carries the answer.
    // Log it, never treat it as a reply.
    case 'E': {
      const message = RE_DIAGNOSTIC.exec(trimmed);
      return { kind: ResponseKind.Diagnostic, raw, message: message ? message[1] : rest };
    }

    default:
      break;
  }

  return { kind: ResponseKind.Unknown, raw };
}

/**
 * Notifications may arrive at any moment, interleaved with command responses,
 * so they are never offered to a pending request as its reply.
 */
export function isNotification(response) {
  return response.kind === ResponseKind.Mode
      || response.kind === ResponseKind.Pressure
      || response.kind === ResponseKind.Diagnostic
      || response.kind === ResponseKind.Empty;
}
