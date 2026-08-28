/**
 * Which transport this browser can actually use.
 *
 * The three web APIs a BP+ can be reached over are not available in the same
 * places, and the gaps are platform-shaped rather than version-shaped:
 *
 *   Web Serial   desktop Chrome and Edge. Present on Android from Chrome ~151,
 *                but see the warning below — it is not the cable there.
 *   WebUSB       desktop and Android Chrome/Edge. Not Safari, not Firefox.
 *   Bluetooth    desktop and Android Chrome/Edge, needs the NUS bridge.
 *
 * The case this exists for is a Chrome tablet: a BP+ on a USB cable has to be
 * reached through WebUSB with a chip driver. Picking that by hand is a step an
 * operator should not have to know about, and getting it wrong looks like a
 * broken cable.
 *
 * ── Why Android is a platform test and not a feature test ──────────────────
 *
 * This module used to detect by feature alone: `navigator.serial` present meant
 * Web Serial was the answer, on the reasoning that a future Android shipping
 * Web Serial would then simply work. That reasoning turned out to be wrong, and
 * the device that disproved it is the one this SDK is for.
 *
 * Chrome 151.0.7922.173 on Android exposes `navigator.serial`, but its port
 * list is NOT the USB cable — it enumerates Bluetooth SPP devices. Measured on
 * that build:
 *
 *   Galaxy S23 Ultra    the picker offers paired Bluetooth devices — car kits,
 *                       headsets — and no cable at all.
 *   Galaxy Tab S10 FE   the cable can be opened from an unfiltered picker, but
 *                       carries no USB vendor id, so a picker filtered on the
 *                       Prolific id matches nothing and reports "No compatible
 *                       device found" with the cable plugged in and working.
 *
 * WebUSB drove the cable on both. So on Android the presence of Web Serial is
 * not evidence that Web Serial can reach a BP+, and preferring it strands the
 * operator on a picker full of headphones. Android therefore takes the WebUSB
 * path whatever `navigator.serial` claims.
 */

export const TransportKind = Object.freeze({
  serial:    'serial',        // Web Serial, over the USB cable
  usbSerial: 'usb-serial',    // WebUSB + a chip driver, over the same cable
  bluetooth: 'bluetooth',     // Web Bluetooth, via the NUS bridge
  simulator: 'simulator',
});

/**
 * What this browser is and what it can do.
 *
 * @returns {{android: boolean, mobile: boolean, handheld: boolean,
 *            secureContext: boolean, webSerial: boolean, webUsb: boolean,
 *            webBluetooth: boolean}}
 */
export function describeEnvironment() {
  const nav = typeof navigator === 'undefined' ? null : navigator;

  return {
    android:       isAndroid(nav),
    mobile:        isMobile(nav),
    // Exposed because it is what survives "Desktop site", and so is the honest
    // answer to "is this a tablet?" when the user agent is not.
    handheld:      isHandheld(nav),
    // Every one of these APIs is refused outside a secure context, so this is
    // usually the real answer when all three look unavailable at once.
    secureContext: typeof isSecureContext === 'boolean' ? isSecureContext : true,
    webSerial:     !!nav && 'serial' in nav,
    webUsb:        !!nav && 'usb' in nav,
    webBluetooth:  !!nav && 'bluetooth' in nav,
  };
}

/**
 * The transport to offer first, and why.
 *
 * Cable before radio: a BP+ on a cable is the arrangement in a clinic, and the
 * Bluetooth path needs a separate bridge that most sites do not have. So the
 * order is Web Serial, then WebUSB, then Bluetooth — the same physical cable
 * for the first two, whichever of them this browser implements.
 *
 * Android is the exception, and takes WebUSB even when Web Serial is present.
 * See the note at the top of this file: Web Serial on Android enumerates
 * Bluetooth SPP devices rather than the USB cable, so its availability there
 * says nothing about whether it can reach a BP+.
 *
 * @param {object} [environment]  from describeEnvironment(); read live if omitted
 * @returns {{kind: string|null, reason: string, environment: object}}
 */
export function recommendedTransport(environment = describeEnvironment()) {
  const env = environment;

  // Before the Web Serial check, not after it.
  if ((env.android || env.handheld) && env.webUsb) {
    return {
      kind: TransportKind.usbSerial,
      reason: env.webSerial
        ? 'On Android, Web Serial lists Bluetooth devices rather than the USB ' +
          'cable, so the adapter is opened directly over WebUSB.'
        : 'Android has no Web Serial here, so the USB-to-serial adapter is ' +
          'opened directly over WebUSB.',
      environment: env,
    };
  }

  if (env.webSerial) {
    return {
      kind: TransportKind.serial,
      reason: 'Web Serial is available, which is the direct way to the cable.',
      environment: env,
    };
  }

  if (env.webUsb) {
    return {
      kind: TransportKind.usbSerial,
      reason: 'This browser has no Web Serial, so the USB-to-serial adapter ' +
        'is opened directly over WebUSB.',
      environment: env,
    };
  }

  if (env.webBluetooth) {
    return {
      kind: TransportKind.bluetooth,
      reason: 'Only Web Bluetooth is available, which needs the BP+ Bridge.',
      environment: env,
    };
  }

  return {
    kind: null,
    reason: env.secureContext
      ? 'This browser has none of Web Serial, WebUSB or Web Bluetooth. ' +
        'Use Chrome or Edge — Safari and Firefox implement none of them.'
      : 'This page is not in a secure context, so the browser refuses all ' +
        'device APIs. Serve it over HTTPS, or from localhost.',
    environment: env,
  };
}

/**
 * Android, by any signal that says so.
 *
 * Every check is positive-only, and a negative from one never short-circuits
 * the next. The previous version returned on `userAgentData.platform`:
 *
 *   if (typeof platform === 'string' && platform) return /android/i.test(platform);
 *   return /android/i.test(nav.userAgent || '');   // dead whenever platform is set
 *
 * which made the UA-string line unreachable in exactly the case it was written
 * for. Chrome's "Desktop site" mode — the default on some Samsung tablets —
 * reports platform "Linux", so that check answered "not Android" on a Galaxy
 * Tab S10 FE and on a Galaxy S23 Ultra. Both then took the Web Serial path
 * that cannot see the cable.
 */
function isAndroid(nav) {
  if (!nav) return false;

  const data = nav.userAgentData;
  if (data && typeof data.platform === 'string' && /android/i.test(data.platform)) {
    return true;
  }
  if (/android/i.test(nav.userAgent || '')) return true;

  // Desktop-site mode rewrites both of the above. What it cannot rewrite is the
  // hardware: a touch screen whose primary pointer is coarse is a handheld.
  return isHandheld(nav);
}

/**
 * A phone or tablet, whatever the user-agent claims to be.
 *
 * This is the last resort in `isAndroid()` and the reason desktop-site mode no
 * longer defeats it. A desktop reports no touch points; a touch laptop reports
 * touch AND a fine pointer, and stays on Web Serial, which is the route that
 * works there.
 *
 * Deliberately not built on `userAgentData.mobile`: that means phone-shaped,
 * and is correctly `false` on a tablet. It reads false on a Tab S10 FE in both
 * Chrome modes, so any rule resting on it fails on the exact device this SDK
 * has to support.
 */
function isHandheld(nav) {
  if (!nav) return false;
  if ((nav.maxTouchPoints || 0) <= 0) return false;

  const mm = typeof globalThis !== 'undefined' && globalThis.matchMedia;
  if (typeof mm !== 'function') return true;   // touch, and nothing to refute it
  return !mm.call(globalThis, '(pointer: fine)').matches;
}

function isMobile(nav) {
  if (!nav) return false;
  // Positive-only, for the same reason as isAndroid(): desktop-site mode sets
  // userAgentData.mobile to false, so a false there is not an answer.
  if (nav.userAgentData && nav.userAgentData.mobile === true) return true;
  return /android|iphone|ipad|ipod|mobile/i.test(nav.userAgent || '');
}
