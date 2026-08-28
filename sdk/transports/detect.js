/**
 * Which transport this browser can actually use.
 *
 * The three web APIs a BP+ can be reached over are not available in the same
 * places, and the gaps are platform-shaped rather than version-shaped:
 *
 *   Web Serial   desktop Chrome and Edge only. Not on Android at all.
 *   WebUSB       desktop and Android Chrome/Edge. Not Safari, not Firefox.
 *   Bluetooth    desktop and Android Chrome/Edge, needs the NUS bridge.
 *
 * The case this exists for is a Chrome tablet: on Android there is no Web
 * Serial, so a BP+ on a USB cable has to be reached through WebUSB with a chip
 * driver instead. Picking that by hand is a step an operator should not have to
 * know about, and getting it wrong looks like a broken cable.
 *
 * Detection is by feature first and platform second. `navigator.serial` being
 * absent is the fact that matters; Android is only used to explain *why* and to
 * order the choices, never as the test itself. A future Android build that
 * shipped Web Serial would then simply work.
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
 * @returns {{android: boolean, mobile: boolean, secureContext: boolean,
 *            webSerial: boolean, webUsb: boolean, webBluetooth: boolean}}
 */
export function describeEnvironment() {
  const nav = typeof navigator === 'undefined' ? null : navigator;

  return {
    android:       isAndroid(nav),
    mobile:        isMobile(nav),
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
 * @param {object} [environment]  from describeEnvironment(); read live if omitted
 * @returns {{kind: string|null, reason: string, environment: object}}
 */
export function recommendedTransport(environment = describeEnvironment()) {
  const env = environment;

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
      reason: env.android
        ? 'Android has no Web Serial, so the USB-to-serial adapter is opened ' +
          'directly over WebUSB.'
        : 'This browser has no Web Serial, so the USB-to-serial adapter is ' +
          'opened directly over WebUSB.',
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

function isAndroid(nav) {
  if (!nav) return false;
  // userAgentData is the non-spoofed form where it exists; the UA string is
  // the fallback, and is what Android Chrome still reports.
  const platform = nav.userAgentData && nav.userAgentData.platform;
  if (typeof platform === 'string' && platform) return /android/i.test(platform);
  return /android/i.test(nav.userAgent || '');
}

function isMobile(nav) {
  if (!nav) return false;
  if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean') {
    return nav.userAgentData.mobile;
  }
  return /android|iphone|ipad|ipod|mobile/i.test(nav.userAgent || '');
}
