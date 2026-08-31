/**
 * AOBP Integration — the survey-page controller.
 *
 * This is a consumer of the BP+ SDK in `../sdk/`. Everything to do with the
 * wire protocol — framing, checksums, result codes, timeouts — lives there.
 * What is left here is the part that is specific to this study: which REDCap
 * fields to fill, which buttons drive it, and what the operator is told.
 *
 * The DOM contract, on the `aobp_visit` instrument.
 *
 * Per position — each may be suffixed `-seated` or `-standing` when the
 * instrument gives the two measurements their own blocks on one page. The
 * suffixed id wins where it exists; the bare id is the fallback, and is what a
 * single-block instrument has always used. See control() below for why that
 * matters: REDCap branching hides a block but leaves it in the DOM, so two
 * blocks sharing one id collide.
 *
 *   #connect-bp-btn        starts the browser's serial port picker
 *   #status-display        the single large status line
 *   #cancel-bp-btn         optional; live only while a measurement is running
 *   #alerts-display        optional; what the device said about the measurement
 *   #visit-state           optional; what the record still needs, and whether
 *                          it is ready to submit
 *
 * Per position, fixed names:
 *
 *   #start-seated-btn      seated measurement, then standing if required
 *   #start-standing-btn    standing measurement on its own
 *   #seated-results-panel  filled after each measurement
 *   #standing-results-panel
 *
 * Page level — one device, so one of each:
 *
 *   #set-aobp-mode-btn     optional; live only when the device is not in AOBP
 *                          mode and can be told to be
 *   #ping-bp-btn           optional; checks the link is live and the device is
 *                          still the one we think it is
 *   #device-info           optional; versions and mode, for an instrument whose
 *                          reader is a technician rather than a nurse
 *
 * Loaded as a classic script, because a REDCap survey page includes it with a
 * plain <script src>. The SDK is ES modules, so it is brought in with a dynamic
 * import() at connect time rather than a top-level one.
 */

(function () {
  'use strict';

  // Captured while the script is being parsed. Inside a DOMContentLoaded
  // handler document.currentScript is null, and the SDK has to be located
  // relative to this file when the server has not told us where it is.
  var THIS_SCRIPT = document.currentScript ? document.currentScript.src : '';

  var FIELD_NAMES = {
    measurement_status: 'sys_measurement_status',
    standing_required:  'sys_standing_required',

    seated: {
      sys:       'seated_ave_sys',
      dia:       'seated_ave_dia',
      hr:        'seated_ave_hr',
      af:        'seated_af',
      datetime:  'seated_datetime',
      guid:      'seated_guid',
      device_id: 'seated_bpplus_device_id',
      snr:       'seated_snr',
      xml:       'seated_raw_xml_text',
    },

    standing: {
      sys:       'standing_ave_sys',
      dia:       'standing_ave_dia',
      hr:        'standing_ave_hr',
      af:        'standing_af',
      datetime:  'standing_datetime',
      guid:      'standing_guid',
      device_id: 'standing_bpplus_device_id',
      snr:       'standing_snr',
      xml:       'standing_raw_xml_text',
    },
  };

  // A serial cable, not the BP+ itself: the device is behind a USB-to-serial
  // bridge, so the port carries the bridge's identifiers. Prolific is what the
  // supplied cable uses.
  //
  // No filter, deliberately. A filter of [{ usbVendorId: 0x067B }] reads as the
  // safe thing to do and is not: on a Samsung Galaxy Tab S10 FE, with the
  // supplied Prolific PL2303GT plugged in and working, requestPort() filtered
  // on that vendor id matches nothing and the picker says "No compatible device
  // found". The same port opens fine from an unfiltered picker, and reports
  // 0x067B:0x23A3 once granted. Whatever the browser is doing there, a filter
  // is the difference between a cable that works and one that appears absent.
  //
  // Unfiltered also keeps the promise this comment used to make and the code
  // did not: a site with a different adapter is not locked out.
  var PORT_FILTERS = null;


  // How far the device clock may be out before it is quietly set to this
  // computer's. The measurement timestamp goes into the result XML, so a device
  // whose clock is wrong mislabels data that cannot be corrected afterwards.
  // Overridden per project with the AOBP_CONFIG.clockToleranceMinutes setting.
  var DEFAULT_CLOCK_TOLERANCE_MINUTES = 5;

  // Module scope on purpose. updateButtons() runs as the first thing start()
  // does, before any `var` inside it has been assigned — putting this there
  // made renderVisitState() read a property of undefined and took the whole
  // module down before window.AOBP was set.
  var VISIT_STYLES = {
    waiting:    { background: '#f8f9fa', border: '1px solid #dee2e6', color: '#5d6b7a' },
    incomplete: { background: '#fff8e1', border: '1px solid #ffe082', color: '#8a6100' },
    complete:   { background: '#d8f3dc', border: '1px solid #b7e4c7', color: '#2d6a4f' },
  };

  // What a BP+ must report before it can take a seated or standing measurement.
  // Body position is the 5th parameter of `s`; older firmware answers F 14.
  var MIN_FEATURE_VERSION = '3.0';   // the feature schema carrying measureMode
  var MIN_API_VERSION     = '2.4';   // the command set accepting body position

  // Set up once per page, however many times we are asked to.
  //
  // A second start() would wire a second click handler onto every button, and
  // one press of Connect would then call requestPort() twice — the second call
  // rejecting as "No port selected by the user" the moment it was made, on top
  // of the picker the first one had just opened.
  var started = false;

  document.addEventListener('DOMContentLoaded', function () {
    if (started) return;
    started = true;
    start().catch(function (error) {
      console.error('[AOBP] failed to start', error);
    });
  });

  async function start() {
    /**
     * One control, for one body position.
     *
     * An instrument may put the seated and standing measurements in separate
     * blocks on the same page, each with its own connect button, status line and
     * results panel. REDCap's branching hides a block with `display:none` but
     * leaves it in the DOM, so two blocks that both use `id="status-display"`
     * collide: getElementById returns the first, and everything the standing
     * measurement says lands in the seated block's status line.
     *
     * So a per-position id wins if the instrument provides one, and the shared
     * id is the fallback — which is what an instrument with a single block, like
     * the one this module shipped against, has always used.
     */
    function control(base, mode) {
      return document.getElementById(base + '-' + mode) ||
             document.getElementById(base);
    }

    function blockFor(mode) {
      return {
        connect: control('connect-bp-btn', mode),
        cancel:  control('cancel-bp-btn', mode),
        status:  control('status-display', mode),
        alerts:  control('alerts-display', mode),
        visit:   control('visit-state', mode),
        panel:   document.getElementById(mode + '-results-panel'),
      };
    }

    var blocks = { seated: blockFor('seated'), standing: blockFor('standing') };

    /**
     * Bind a handler to a control once, however many positions share it.
     *
     * An instrument with one block has no per-position ids, so both positions
     * resolve to the same button — and wiring per position then put two
     * listeners on it. One press ran connect() twice: two requestPort() calls,
     * the second rejected as "No port selected by the user" the instant it was
     * made, and that rejection overwrote the status line while the operator was
     * still looking at the picker the first one opened.
     */
    var wired = [];

    function once(element, handler) {
      if (!element || wired.indexOf(element) !== -1) return false;
      wired.push(element);
      element.addEventListener('click', handler);
      return true;
    }

    // Which block the operator is working in, and therefore where messages go.
    var currentMode = 'seated';

    var ui = {
      seated:   document.getElementById('start-seated-btn'),
      standing: document.getElementById('start-standing-btn'),
      // Page-level rather than per position: one device, one set of versions.
      setAobp:  document.getElementById('set-aobp-mode-btn'),
      ping:     document.getElementById('ping-bp-btn'),
      info:     document.getElementById('device-info'),
    };

    if (!blocks.seated.connect && !ui.seated && !ui.standing) return;   // not our instrument

    // What each Start button said before anything was measured. Captured here
    // and not at the wiring below, because updateButtons() runs during start-up
    // and a `var` read before its assignment is undefined, not an error — the
    // same trap that once shipped a module dead on load. Captured once, too:
    // the label is rewritten in place, so reading it back later would compound
    // whatever it was last set to.
    var startLabel = {
      seated:   ui.seated   ? ui.seated.textContent   : '',
      standing: ui.standing ? ui.standing.textContent : '',
    };


    var sdk = null;          // the imported module namespace
    var device = null;
    var features = null;     // the reply to `f`, read once at connect
    var apiVersion = null;   // the reply to `ver`, or null if it could not be read
    var lastMeasurement = null;

    // Kept so a failed upload can be tried again without repeating the
    // measurement on the participant. Cleared once the file is stored.
    var pendingXml = { seated: null, standing: null };
    var lastClockSync = null;
    var busy = false;                 // a measurement is on the arm right now
    var seatedDone = false;
    var standingDone = false;
    var measurementComplete = false;

    updateButtons();

    // ── Status line ─────────────────────────────────────────────────────────

    var STATUS_STYLES = {
      ready:   { background: '#f8f9fa', border: '1px solid #dee2e6', color: '#495057' },
      normal:  { background: '#e8f4fd', border: '1px solid #cfe2ff', color: '#000000' },
      success: { background: '#d8f3dc', border: '1px solid #b7e4c7', color: '#2d6a4f' },
      error:   { background: '#fdecea', border: '1px solid #f5c2c0', color: '#b71c1c' },
    };

    /**
     * @param {string} [mode]  'seated' | 'standing' | 'all'. Defaults to the
     *        block the operator is working in. 'all' is for a message that is
     *        true of the page rather than of one measurement — an operator who
     *        scrolls to the standing block first should not find it blank.
     */
    function setStatus(kind, message, mode) {
      console.log('[AOBP] ' + kind.toUpperCase() + ':', message);

      if (mode === 'all') {
        for (var each in blocks) setStatus(kind, message, each);
        return;
      }

      var el = blocks[mode || currentMode].status;
      if (!el) return;

      var style = STATUS_STYLES[kind] || STATUS_STYLES.normal;
      el.style.background = style.background;
      el.style.border     = style.border;
      el.style.color      = style.color;
      el.style.fontSize   = '24px';
      el.style.fontWeight = '600';
      el.style.textAlign  = 'center';
      el.style.padding    = '18px';
      el.innerText = message;
    }

    // ── REDCap fields ───────────────────────────────────────────────────────

    function setFieldValue(name, value) {
      if (!name) return;
      var field = document.querySelector('[name="' + name + '"]');
      if (!field) return;
      field.value = value === null || value === undefined ? '' : String(value);
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * Read a field the instrument is expected to supply.
     *
     * A missing field is said out loud, because the alternative is worse than a
     * wrong answer: it is the right answer to a question nobody asked. The one
     * value read this way is sys_standing_required, and when the element is
     * absent this returns null, `null === '1'` is false, and no participant is
     * ever asked to stand — for the whole study, without an error anywhere.
     *
     * Three ways that happens: the value arrives as a URL parameter rather than
     * a field, the field is named differently on this instrument, or it was
     * never added. All three look identical from here, so this says what it
     * looked for rather than guessing which.
     */
    function getFieldValue(name) {
      var field = document.querySelector('[name="' + name + '"]');
      if (!field) {
        console.warn('[AOBP] no field named "' + name + '" on this page. ' +
                     'Reading it as empty — if the value is meant to come from ' +
                     'somewhere else, such as a URL parameter, this module ' +
                     'cannot see it.');
        return null;
      }
      return field.value;
    }

    /**
     * REDCap renders a radio as a set of buttons, and only a click on the right
     * one records the choice — setting .value on the group does nothing.
     */
    function setRadio(name, value) {
      var button = document.getElementById('opt-' + name + '_' + value);
      if (button) { button.click(); return true; }

      var input = document.querySelector('[name="' + name + '"][value="' + value + '"]');
      if (input) { input.click(); return true; }

      console.warn('[AOBP] could not set radio', name, '=', value);
      return false;
    }

    // ── The device ──────────────────────────────────────────────────────────

    async function loadSdk() {
      if (sdk) return sdk;
      sdk = await import(sdkUrl());
      return sdk;
    }

    async function connect() {
      var api = await loadSdk();

      var transport = makeTransport(api);
      // A measurement started on the device carries no patient ID and belongs
      // to no record, so the module refuses it. Every measurement in this study
      // has to come from this page.
      device = new api.BpPlusDevice(transport, { hostStartedOnly: true });

      device.on('warning', function (w) { console.warn('[AOBP]', w.message); });

      device.on('deviceStarted', function (event) {
        console.warn('[AOBP] measurement started on the device (' +
                     event.mode.name + '); ' +
                     (event.cancelling ? 'cancelling it' : 'watching'));
        setStatus('error', event.cancelling
          ? 'That measurement was started on the BP+ itself and has been ' +
            'stopped. Use the buttons on this page, so the reading is saved ' +
            'against the right participant.'
          : 'Please start the measurement from this page rather than from the ' +
            'BP+, so the reading is saved against the right participant.');
      });
      // The link can go while nobody is asking it anything: the cable leaves
      // the computer, Chrome tells us the device is gone, and until now the
      // page carried on showing a connected BP+ and two live Start buttons.
      // Nothing said otherwise until the next command failed.
      device.on('state', function (state) {
        if (device && device.isConnected) return;

        features = null;
        device = null;
        showConnectButtons();
        updateButtons();
        setStatus('error', 'The BP+ has been disconnected. Check the cable is ' +
          'plugged into the computer and into the BP+, then press Connect BP+.',
          'all');
        console.warn('[AOBP] the device went away (' + state + ')');
      });

      device.on('log', function (entry) {
        if (window.AOBP_CONFIG && window.AOBP_CONFIG.trace) {
          console.log('[AOBP] ' + (entry.dir === 'tx' ? '>' : '<'), entry.text);
        }
      });

      await device.connect();
      await verify();
    }

    /**
     * Ask the open port whether a BP+ is on the end of it.
     *
     * Split from connect() because it is the half that fails when the cable is
     * not in the BP+, and the half worth retrying on its own. The port opened
     * fine; nothing about it is wrong. Retrying here costs the operator one
     * press, where reopening costs them the browser's port picker as well.
     */
    async function verify() {
      setStatus('normal', 'Checking the BP+ — please wait…', 'all');

      // device.connect() only opens the port — it sends nothing and waits for
      // nothing. The feature list is the first thing the device actually
      // says, so it is what proves a BP+ is on the other end at all.
      //
      // Every BP+ answers `f`; silence means the port opened onto something
      // that is not a BP+ — the wrong COM port, or a cable with nothing on
      // the end. Reporting that as a connection would hand the operator a
      // green status line and two live buttons attached to nothing.
      features = await device.readFeatures();

      apiVersion = await device.readApiVersion().catch(function (error) {
        console.warn('[AOBP] no Terminal API version:', error.message);
        return null;
      });

      console.log('[AOBP] device ' + features.deviceId +
                  ', firmware ' + features.softwareVersion +
                  ', feature list ' + features.version +
                  ', Terminal API ' + (apiVersion || 'unknown') +
                  ', mode ' + features.measureModeInfo.label);

      var shortfall = capabilityShortfall(features, apiVersion);
      if (shortfall) throw new Error(shortfall);
    }

    /**
     * Whether this device can do an AOBP visit at all, or null when it can.
     *
     * Body position is the 5th parameter of `s`, and a device that predates it
     * answers F 14 to a seated or standing measurement. That is a firmware
     * problem, not something the operator can work around, so it is found at
     * connect rather than at the first participant.
     *
     * Two independent statements of the same requirement, both checked because
     * either alone can be missing or misreported:
     *
     *   feature list >= 3.0   the schema that carries measureMode
     *   Terminal API  >= 2.4  the command set that accepts body position
     */
    function capabilityShortfall(list, api) {
      if (atLeast(list.version, MIN_FEATURE_VERSION) === false) {
        return 'This BP+ reports feature list ' + list.version + '. Version ' +
               MIN_FEATURE_VERSION + ' or later is needed for seated and ' +
               'standing measurements — the device needs a software update.';
      }

      if (api !== null && atLeast(api, MIN_API_VERSION) === false) {
        return 'This BP+ reports Terminal API ' + api + '. Version ' +
               MIN_API_VERSION + ' or later is needed for seated and standing ' +
               'measurements — the device needs a software update.';
      }

      return null;
    }

    /**
     * The transport to talk over, chosen from what this browser can do.
     *
     * A desktop gets Web Serial. An Android tablet has no Web Serial at all, so
     * the same USB cable is reached through WebUSB instead — the operator sees
     * no difference, and hard-coding Web Serial here would simply refuse to
     * connect on a tablet.
     *
     * The AOBP_TRANSPORT hook exists so the test harness can run this same code
     * against the SDK simulator without a device attached; nothing in REDCap
     * sets it.
     */
    function makeTransport(api) {
      if (typeof window.AOBP_TRANSPORT === 'function') {
        return window.AOBP_TRANSPORT(api);
      }

      var pick = api.recommendedTransport();
      var env  = pick.environment;

      // No platform logic here. The SDK decides, and on Android that means
      // WebUSB even where navigator.serial exists, because Web Serial there
      // enumerates Bluetooth SPP devices rather than the cable — the note at the
      // top of sdk/transports/detect.js carries the measurements.
      //
      // The flags are logged because "it picked the wrong transport" is the
      // first thing to check when a cable that works on a desktop does not work
      // on a tablet.
      console.log('[AOBP] transport: ' + pick.kind + ' — ' + pick.reason +
                  ' (android=' + env.android + ' handheld=' + env.handheld +
                  ' webSerial=' + env.webSerial + ')');

      if (pick.kind === api.TransportKind.serial) {
        return new api.WebSerialTransport({ filters: PORT_FILTERS });
      }
      if (pick.kind === api.TransportKind.usbSerial) {
        return new api.UsbSerialTransport();
      }

      // Bluetooth needs the separate BP+ Bridge, which this study does not use,
      // so anything else is reported rather than half-attempted.
      throw new Error(
        'This browser cannot reach a BP+ on a cable. ' + pick.reason
      );
    }

    /** True when the DEVICE is in AOBP mode, which is what makes `s` accept a body position. */
    function deviceIsAobp() {
      return !!features && features.measureMode === sdk.MeasureMode.bpPlusAobp;
    }

    /**
     * The record ID, sent to the device so the measurement identifies itself.
     *
     * The device accepts letters, digits and hyphens; a REDCap record ID can
     * hold characters it will refuse, so anything else becomes a hyphen rather
     * than costing an F 14 at the start of a measurement.
     */
    function patientId() {
      var cfg = window.AOBP_CONFIG || {};
      var raw = String(cfg.record === undefined || cfg.record === null ? '' : cfg.record);
      var safe = raw.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64);
      return safe;
    }

    /**
     * Put the device clock right before a measurement, if it has drifted.
     *
     * Silent by design: the operator is mid-visit and the clock is not their
     * problem. It is logged, and a failure is swallowed — a device that will
     * not take a time is still a device that can measure, and refusing to
     * measure over it would be the worse outcome.
     */
    async function syncClock() {
      var cfg = window.AOBP_CONFIG || {};
      var minutes = Number(cfg.clockToleranceMinutes);
      if (!isFinite(minutes) || minutes < 0) minutes = DEFAULT_CLOCK_TOLERANCE_MINUTES;

      try {
        var result = await device.syncTime({ toleranceMs: minutes * 60 * 1000 });
        lastClockSync = result;
        console.log('[AOBP] clock: ' + result.reason +
          (result.driftMs === null ? '' : ' (drift ' + Math.round(result.driftMs / 1000) + ' s)'));
        return result;
      } catch (error) {
        console.warn('[AOBP] the device clock could not be checked:', error.message);
        lastClockSync = { synced: false, driftMs: null, before: null, after: null,
                          reason: 'The clock could not be checked: ' + error.message };
        return lastClockSync;
      }
    }

    async function measure(mode) {
      await syncClock();

      var options = { patientId: patientId() };

      if (deviceIsAobp()) {
        // The body position is the 5th parameter of `s`, and the device
        // records it in the result XML. Without it the two visits are
        // indistinguishable in the stored file.
        options.aobp = { bodyPosition: mode };
      }

      return device.measure(options);
    }

    // ── Results ─────────────────────────────────────────────────────────────

    function readingsOf(measurement) {
      return measurement.readings.map(function (r, i) {
        return { n: i + 1, sys: r.sys, dia: r.dia, pr: r.pr };
      });
    }

    function renderPanel(mode, measurement) {
      var panel = blocks[mode].panel;
      if (!panel) return;

      var theme = mode === 'seated'
        ? { bg: '#f4f9ff', border: '#cfe2ff', title: '#0b5394', label: 'Seated AOBP Results' }
        : { bg: '#fffaf0', border: '#ffe69c', title: '#856404', label: 'Standing AOBP Results' };

      var bp = measurement.brachial;
      var rhythm = measurement.rhythm;
      var quality = measurement.signalQuality;
      var readings = readingsOf(measurement);

      var readingRows = readings.length > 1
        ? '<div style="margin-top:14px;font-size:16px;color:#555;">' +
            readings.map(function (r) {
              return 'Reading ' + r.n + ': <strong>' + r.sys + '/' + r.dia +
                     '</strong> mmHg, ' + r.pr + ' bpm';
            }).join('<br>') +
          '</div>'
        : '';

      var rhythmText = !rhythm.known
        ? 'Not reported'
        : (rhythm.irregular
            ? 'Yes (sPRV = ' + rhythm.sPRV + ' ms)'
            : 'No');

      panel.innerHTML =
        '<div style="background:' + theme.bg + ';border:1px solid ' + theme.border +
        ';border-radius:10px;padding:20px;text-align:center;margin-top:15px;">' +

          '<div style="font-size:24px;font-weight:600;color:' + theme.title +
          ';margin-bottom:12px;">' + theme.label + '</div>' +

          '<div style="font-size:44px;font-weight:700;color:#222;">' +
            escapeHtml(bp.sys) + ' / ' + escapeHtml(bp.dia) +
          '</div>' +

          '<div style="font-size:18px;color:#666;margin-bottom:15px;">mmHg' +
            (readings.length > 1 ? ' — mean of ' + readings.length + ' readings' : '') +
          '</div>' +

          '<div style="font-size:22px;margin-bottom:8px;">Heart Rate: <strong>' +
            escapeHtml(bp.pr) + '</strong> bpm</div>' +

          '<div style="font-size:22px;">Abnormal Heart Rhythm: <strong>' +
            escapeHtml(rhythmText) + '</strong></div>' +

          (quality.known
            ? '<div style="font-size:16px;color:#666;margin-top:10px;">Signal quality: ' +
              escapeHtml(quality.label) + ' (SNR ' + escapeHtml(quality.snr) + ')</div>'
            : '') +

          readingRows +
        '</div>';
    }

    // Green when the device is reporting a good measurement, amber when it is
    // reporting one it does not fully trust, red for a fault. The panel takes
    // the worst of what it holds.
    var ALERT_STYLES = {
      good:    { background: '#d8f3dc', border: '1px solid #b7e4c7', color: '#2d6a4f' },
      caution: { background: '#fff8e1', border: '1px solid #ffe082', color: '#8a6100' },
      bad:     { background: '#fdecea', border: '1px solid #f5c2c0', color: '#b71c1c' },
    };

    /**
     * Show what the device said, in its own words.
     *
     * One line, and more only when there is something to say.
     *
     * An AOBP run is three blood-pressure determinations and then one
     * suprasystolic capture, and each part can report separately: three Alerts
     * and one SNR. Showing four lines every time makes the operator adjudicate
     * a result that is usually simply fine. Showing one line and hiding a
     * failed determination is worse — nobody is in the room while it runs, so
     * the panel is the only chance to notice.
     *
     * So: the summary is the signal quality, and a determination that went
     * wrong is named underneath it. A clean run is one green line.
     *
     * Messages only. Each alert also carries the TM2917 hex result, which is
     * the module's raw reply: it belongs in the console and in a support
     * report, and means nothing to the person holding the cuff.
     */
    function showAlerts(alerts, quality, succeeded, mode) {
      var el = blocks[mode || currentMode].alerts;
      if (!el) return;

      var every = alerts || [];

      // Every alert is logged, whatever is shown. The console and the record
      // keep the device's full account; this decides only what the operator is
      // asked to react to.
      for (var j = 0; j < every.length; j++) {
        var each = every[j];
        console.warn('[AOBP] device alert (' + each.severity + ')' +
                     (each.readings.length ? ' BP' + each.readings.join('/') : '') +
                     ': ' + each.message +
                     ' [' + (each.tm2917_hex_result || 'no hex') + ']');
      }

      // No finish code, no problem to report.
      //
      // The TM2917 retries a determination it could not measure, up to three
      // times, and says so afterwards even when a later attempt succeeded. So a
      // measurement that came back clean still carried "Unable to measure BP:
      // Please Repeat (C13)" from the attempt that was thrown away — shown in
      // red, over a good reading, with nothing for the operator to do about it.
      // Motion artefact during one attempt is the ordinary way to meet this.
      //
      // What matters clinically is whether the device finished: an `F nn`
      // finish code means no reading, and that is reported. Recovered attempts
      // are a real signal — a participant who needs three goes every visit is
      // worth knowing about — but reporting them as errors trains the operator
      // to ignore the panel, which is worse than not showing them. They wait
      // for a motion flag to be reported properly.
      //
      // Set AOBP_CONFIG.detailedWarnings = true to see them anyway.
      var cfg = window.AOBP_CONFIG || {};
      var list = (succeeded && cfg.detailedWarnings !== true)
        ? every.filter(function (alert) { return alert.severity === 'good'; })
        : every;
      if (!list.length && !(quality && quality.known)) {
        el.style.display = 'none';
        el.innerText = '';
        return;
      }

      var worst = 'good';
      var trouble = [];

      for (var i = 0; i < list.length; i++) {
        var alert = list[i];

        if (alert.severity === 'bad') worst = 'bad';
        else if (alert.severity === 'caution' && worst !== 'bad') worst = 'caution';

        // A per-determination quality report is the good news the summary line
        // already carries; only what went wrong is worth a line of its own.
        if (alert.severity !== 'good') {
          trouble.push(alert.readings.length
            ? 'BP' + alert.readings.join(' and BP') + ': ' + alert.message
            : alert.message);
        }
      }

      var summary;
      if (quality && quality.known) {
        if (!quality.usable && worst === 'good') worst = 'caution';
        summary = 'Measurement: ' + quality.label + ' signal (SNR ' + quality.snr + ')';
      } else {
        summary = list.length === 1 && !trouble.length
          ? 'Measurement: ' + list[0].message
          : 'Device alert';
      }

      if (trouble.length) {
        summary += ' — ' + (trouble.length === 1 ? '1 reading' : trouble.length + ' readings') +
                   ' reported a problem';
      }

      var style = ALERT_STYLES[worst] || ALERT_STYLES.bad;
      el.style.display      = '';
      el.style.background   = style.background;
      el.style.border       = style.border;
      el.style.color        = style.color;
      el.style.borderRadius = '8px';
      el.style.padding      = '10px 14px';
      el.style.marginTop    = '10px';
      el.style.fontWeight   = '600';

      var newline = String.fromCharCode(10);
      el.innerText = trouble.length
        ? summary + newline + '• ' + trouble.join(newline + '• ')
        : summary;
    }

    function storeResult(mode, measurement) {
      var fields = FIELD_NAMES[mode];
      var bp = measurement.brachial;

      setFieldValue(fields.sys, bp.sys);
      setFieldValue(fields.dia, bp.dia);
      setFieldValue(fields.hr,  bp.pr);
      setFieldValue(fields.datetime,  measurement.timestamp);
      setFieldValue(fields.guid,      measurement.guid);
      setFieldValue(fields.device_id, measurement.deviceId);

      // The signal-to-noise ratio of the suprasystolic capture — one number per
      // measurement, however many blood-pressure determinations preceded it.
      // The raw dB rather than its band label: the label is an interpretation
      // of this number and can be recomputed, but a band that moved would leave
      // a stored label wrong with nothing to check it against.
      //
      // It is here and the alerts are not for the same reason. This is a
      // measured value; an alert needs the determination it sits on to mean
      // anything, and stripped of that it asks a researcher to invent rules for
      // reading it. The raw XML is retained and holds both properly, so the
      // record loses nothing by keeping only what stands on its own.
      setFieldValue(fields.snr, measurement.signalQuality.snr);


      // The raw XML carries the base64 pressure recordings and runs to well
      // over 100 kB on an AOBP measurement. A REDCap text field will not hold
      // that, so it is stored only when the field exists and is warned about
      // when it is close to a size a text field will truncate.
      if (fields.xml) {
        var xml = measurement.xml || '';
        if (xml.length > 60000) {
          console.warn('[AOBP] the result XML is ' + xml.length +
                       ' characters; a REDCap text field will not hold it. ' +
                       'Store it as a file instead (see README).');
        }

        // Written whole, and replaced by a marker once the file is safely
        // stored. This order is deliberate: if the upload fails, or files are
        // not configured for this project, the field still holds whatever
        // REDCap will keep of the XML. That is truncated and imperfect, and it
        // is better than a record that mentions a file nobody saved.
        setFieldValue(fields.xml, xml);
      }

      var rhythm = measurement.rhythm;
      if (rhythm.known) setRadio(fields.af, rhythm.irregular ? '1' : '0');
    }

    // ── Running one measurement ─────────────────────────────────────────────

    async function runMeasurement(mode) {
      var label = mode === 'seated' ? 'Seated' : 'Standing';

      if (!device) {
        setStatus('error', 'Please connect the BP+ first.');
        return false;
      }

      showAlerts([], null, false, mode);
      setStatus('normal', label + ': measuring — keep the arm still.');

      // Cancel is live only while the cuff is on the arm. A participant who
      // wants to stop should not be waiting on the operator finding the
      // device's own button, and the alternative — pulling the cable — leaves
      // the device mid-measurement.
      var measurement;
      busy = true;
      updateButtons();
      try {
        measurement = await measure(mode);
      } catch (error) {
        setStatus('error', label + ': ' + describe(error));
        showAlerts(error.alerts, null, false, mode);
        console.error('[AOBP]', error);
        return false;
      } finally {
        busy = false;
        updateButtons();
      }

      if (measurement.crcOk === false) {
        setStatus('error',
          label + ': the result arrived corrupted (checksum mismatch). ' +
          'Repeat the measurement.');
        return false;
      }

      // A result block is not the same as a measurement.
      //
      // When the cuff cannot be inflated — a kinked hose is the ordinary way to
      // meet this — the device ends the request and returns a result with no
      // blood pressure in it. Only the transport-level failures reject; this
      // one arrives looking like an answer. Stored unchecked it wrote empty
      // readings into the record, reported "Seated assessment complete", and
      // left the operator with every button disabled and no way back except
      // reloading the page.
      // Whether the result is a reading at all is the SDK's judgement, made
      // against the device's own declared ranges — device.measure() rejects an
      // unusable result before it reaches here, so there is nothing to repeat.

      lastMeasurement = measurement;
      showAlerts(sdk.alertsOf(measurement, features && features.bpRange),
                 measurement.signalQuality, true, mode);
      setStatus('normal', label + ': saving results…');
      storeResult(mode, measurement);
      renderPanel(mode, measurement);

      // Announced after the fields are filled, so a listener sees the record
      // in the state REDCap will save it. The test harness checks the result
      // this way; a project can use it to drive anything else on the page.
      document.dispatchEvent(new CustomEvent('aobp:measurement', {
        detail: { mode: mode, measurement: measurement },
      }));

      // Best effort, and deliberately after the fields are filled: the
      // measurement is already recorded whether or not the file is stored.
      await saveXmlAsFile(mode, measurement.xml);

      return true;
    }

    /**
     * Ask the server to keep the raw XML as a file on the record.
     *
     * A full AOBP result runs past 100 kB because of the base64 pressure
     * recordings, which is more than a REDCap text field holds. This is the
     * place to put it, but it needs file-upload fields and the project setting
     * turned on, so a failure here is reported and then let go rather than
     * failing a measurement that has already been taken.
     */
    async function saveXmlAsFile(mode, xml) {
      var cfg = window.AOBP_CONFIG || {};
      if (!cfg.saveXmlAsFile || !xml) return;

      if (typeof ExternalModules === 'undefined' || !ExternalModules.ajax) {
        uploadFailed(mode, 'The External Modules helper is not on this page.');
        return;
      }

      pendingXml[mode] = xml;

      try {
        var reply = await ExternalModules.ajax('save-xml', { mode: mode, xml: xml });

        if (!reply || reply.status !== 'success') {
          uploadFailed(mode, (reply && reply.message) || 'The server did not say why.');
          return;
        }

        console.log('[AOBP] stored ' + reply.filename + ' in ' + reply.field);
        pendingXml[mode] = null;
        hideResend(mode);
        await markStored(mode, xml, reply);
      } catch (error) {
        uploadFailed(mode, error && error.message ? error.message : String(error));
      }
    }

    /**
     * Replace the XML in the text field with a note saying where it went.
     *
     * REDCap keeps only the first part of a value that long, so what sat in the
     * text field was a piece of an XML document formatted to look like a whole
     * one — the worst of both, since it reads as data. A marker says plainly
     * that the measurement is in the file field, and carries the length and
     * digest of what was sent, so the file on the record can be checked against
     * what the device produced rather than taken on trust.
     */
    async function markStored(mode, xml, reply) {
      var fields = FIELD_NAMES[mode];
      if (!fields.xml) return;

      var digest = await sha256Hex(xml);

      setFieldValue(fields.xml,
        'stored-as-file' +
        ' field=' + (reply.field || '?') +
        ' filename=' + (reply.filename || '?') +
        ' bytes=' + byteLength(xml) +
        ' sha256=' + (digest || 'unavailable') +
        ' at=' + new Date().toISOString());
    }

    /** Bytes, not characters: the XML is UTF-8 by the time it is a file. */
    function byteLength(text) {
      return typeof TextEncoder === 'undefined'
        ? text.length
        : new TextEncoder().encode(text).length;
    }

    /**
     * SHA-256, or null where the page is not allowed one.
     *
     * crypto.subtle exists only in a secure context. A survey is served over
     * HTTPS, so this is available in the field; a file:// harness is not, and
     * the marker says so rather than carrying a wrong digest.
     */
    async function sha256Hex(text) {
      if (typeof crypto === 'undefined' || !crypto.subtle) return null;
      try {
        var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        var out = [];
        new Uint8Array(digest).forEach(function (b) {
          out.push(b < 16 ? '0' + b.toString(16) : b.toString(16));
        });
        return out.join('');
      } catch (error) {
        console.warn('[AOBP] could not hash the XML:', error.message);
        return null;
      }
    }

    /**
     * Say that the recording did not reach the server, and offer another go.
     *
     * The measurement itself is safe — the numbers are in their fields and the
     * text field still holds what REDCap will keep of the XML. What is at risk
     * is the full recording, which exists nowhere but this browser tab until it
     * is uploaded, and is gone when the page closes. That is worth interrupting
     * for, and worth a button: repeating the measurement on the participant to
     * recover a file is not a reasonable thing to ask.
     */
    function uploadFailed(mode, why) {
      console.warn('[AOBP] the ' + mode + ' recording was not stored: ' + why);
      setStatus('error',
        'The ' + mode + ' measurement is saved, but its full recording did ' +
        'not reach the server. Press Resend recording. Do not close this page ' +
        'until it succeeds.', mode);
      showResend(mode);
    }

    /**
     * The Resend button, made here because no instrument declares one.
     *
     * It appears only when there is something to resend, next to the status
     * line for that position.
     */
    function showResend(mode) {
      var id = 'aobp-resend-' + mode;
      var button = document.getElementById(id);

      if (!button) {
        var host = blocks[mode].alerts || blocks[mode].status;
        if (!host || !host.parentNode) return;

        button = document.createElement('button');
        button.id = id;
        button.type = 'button';
        button.textContent = 'Resend recording';
        button.style.marginTop = '10px';
        button.style.padding = '10px 18px';
        button.style.fontWeight = '600';
        button.style.cursor = 'pointer';

        button.addEventListener('click', async function () {
          var xml = pendingXml[mode];
          if (!xml) return;

          setEnabled(button, false);
          setStatus('normal', 'Sending the ' + mode + ' recording…', mode);
          await saveXmlAsFile(mode, xml);
          setEnabled(button, true);

          if (!pendingXml[mode]) {
            setStatus('success', 'The ' + mode + ' recording is stored.', mode);
          }
        });

        host.parentNode.insertBefore(button, host.nextSibling);
      }

      button.style.display = '';
      setEnabled(button, true);
    }

    function hideResend(mode) {
      var button = document.getElementById('aobp-resend-' + mode);
      if (button) button.style.display = 'none';
    }

    /** Turn an SDK error into something an operator can act on. */
    function describe(error) {
      if (!error) return 'The measurement failed.';

      // A BpPlusError already carries a sentence written for a person, and a
      // Table 5 code a script can branch on.
      if (error.code !== undefined && error.message) {
        // Who stopped it decides how it reads. F 02 comes back the same either
        // way, so the SDK tags the cancel it was asked to send; without that
        // the page told an operator who had just pressed Cancel that the
        // measurement had been cancelled at the device.
        if (sdk && error.code === sdk.ResultCode.cancelled) {
          return error.reason === sdk.ErrorReason.cancelledByHost
            ? 'Measurement cancelled. Press start when you are ready.'
            : 'The measurement was stopped at the BP+. Press start to try again.';
        }

        // A result the device produced but that is not a reading: the cuff and
        // the hose are what the operator can actually do something about. What
        // the device itself said goes to the alerts panel, not into this line.
        if (sdk && (error.code === sdk.ResultCode.measurementDataInvalid ||
                    error.code === sdk.ResultCode.measurementBPOutOfRange ||
                    error.code === sdk.ResultCode.nibpDeviceError)) {
          return error.message +
                 ' Check the cuff and the hose for a kink, then repeat the measurement.';
        }

        // Everything the SDK can name, in the SDK's words.
        //
        // This used to be a regex over Chrome's English — in the application,
        // one layer above the code that knew perfectly well which failure it
        // had hit. A browser reword would have turned a specific instruction
        // back into a shrug, silently. The transport now tags the error and
        // adviseOn() turns the tag into something to do; both are the SDK's, so
        // every project on it gets the same answer.
        //
        // "Device" becomes "BP+" on the way out. The SDK serves more than this
        // study and cannot assume the name; the operator only knows the one.
        if (sdk && sdk.adviseOn) {
          var advice = sdk.adviseOn(error);
          if (advice) {
            return advice.replace(/\bthe device\b/gi, function (found) {
              return found.charAt(0) === 'T' ? 'The BP+' : 'the BP+';
            });
          }
        }

        return error.message;
      }
      return error.message || String(error);
    }

    // ── Buttons ─────────────────────────────────────────────────────────────

    /**
     * Connect, from whichever block the operator pressed it in.
     *
     * One device serves both positions, so the first connect is the only one
     * that opens a port. A second press from the other block finds the device
     * already connected and simply reports it, rather than sending the operator
     * back to the browser's picker.
     */
    function wireConnect(mode) {
      var button = blocks[mode].connect;

      once(button, async function () {
        currentMode = mode;

        if (device && features) {
          setStatus('success', 'BP+ already connected.', mode);
          hideConnectButtons();
          updateButtons();
          return;
        }

        // A port that opened but did not answer is kept, not given back.
        //
        // The usual reason it did not answer is that the cable is not in the
        // BP+ yet, and nothing is wrong with the port at all — so the second
        // press plugs the cable in and asks again, with no browser picker in
        // the way. It also steps around a port that will not close: with
        // hardware flow control and no CTS the write to `f` never drains, and
        // close() waits on bytes that cannot leave. The port we could not shut
        // is the one we now keep, which suits both.
        //
        // To pick a different port, reload the page.
        var retrying = !!device && device.transport.isConnected;

        setEnabled(button, false);
        setStatus('normal', retrying
          ? 'Checking the BP+ — please wait…'
          : 'Select the BP+ serial port…', mode);
        try {
          if (retrying) await verify();
          else await connect();
          setStatus(deviceIsAobp() ? 'success' : 'error',
            deviceIsAobp()
              ? 'BP+ connected.'
              : 'BP+ connected, but it is not in AOBP mode. ' +
                (canSetAobpMode() && ui.setAobp
                  ? 'Press Set AOBP mode to switch it.'
                  : 'It must be switched to AOBP mode before it can be used.'),
            'all');
          hideConnectButtons();
          updateButtons();
        } catch (error) {
          // The device object survives only while its port does. Chrome fires
          // `disconnect` when the cable leaves the computer, and the transport
          // marks itself disconnected on it, so an unplugged cable falls back
          // to a fresh port and the picker rather than retrying into nothing.
          if (device && !device.transport.isConnected) device = null;
          features = null;
          setEnabled(button, true);
          setStatus('error', describe(error), mode);
          console.error('[AOBP]', error);
        }
      });
    }

    /** Once the device is open, no block needs to offer Connect again. */
    function hideConnectButtons() {
      for (var mode in blocks) {
        if (blocks[mode].connect) blocks[mode].connect.style.display = 'none';
      }
    }

    /** And back again when the device goes away mid-visit. */
    function showConnectButtons() {
      for (var mode in blocks) {
        if (blocks[mode].connect) {
          blocks[mode].connect.style.display = '';
          setEnabled(blocks[mode].connect, true);
        }
      }
    }

    wireConnect('seated');
    wireConnect('standing');

    /**
     * Take one measurement and then work out what the visit still needs.
     *
     * Both buttons run through here. They used to have separate bodies that
     * each did their own enabling, which is how the standing path came to
     * disable Start seated and never restore it: press Start standing first and
     * the seated measurement became unreachable for the rest of the visit.
     * There is now one path and one place that decides what is live.
     */
    async function takeMeasurement(mode) {
      currentMode = mode;

      if (!device) {
        setStatus('error', 'Please connect the BP+ first.');
        return;
      }

      // A repeat replaces the stored reading for this position. Said only to
      // the console: the operator asked for it, and the status line is about to
      // be taken over by the measurement itself.
      if (measurementComplete) {
        console.log('[AOBP] repeating the ' + mode + ' measurement; the stored ' +
                    'reading for that position will be replaced');
      }

      var ok = await runMeasurement(mode);
      if (!ok) return;              // runMeasurement has already restored the buttons

      if (mode === 'seated') seatedDone = true; else standingDone = true;

      if (mode === 'seated' && standingRequired() && !standingDone) {
        var cfg = window.AOBP_CONFIG || {};

        // Two flows, because the original module and this one disagree about
        // which is right and the study has not yet decided.
        //
        //   autoAdvanceStanding on   the standing measurement follows on a
        //                            timer, as aobp_integration_v1.0.1 does.
        //   off (default)            the module stops and waits for the
        //                            operator to press Start standing.
        //
        // The timer is the riskier of the two: the cuff inflates when it
        // expires whether or not the participant is upright and settled. It is
        // off unless a project asks for it.
        if (cfg.autoAdvanceStanding) {
          var seconds = autoAdvanceSeconds(cfg);
          setStatus('normal',
            'Seated done. Please stand the participant — the standing ' +
            'measurement starts in ' + seconds + ' seconds.');
          await delay(seconds * 1000);

          if (!(await runMeasurement('standing'))) return;
          standingDone = true;
        } else {
          setStatus('normal',
            'Seated done. Stand the participant, then press Start standing.');
          updateButtons();
          return;                             // the operator decides when
        }
      }

      finish(mode);
    }

    /** True when the record has everything this visit was asked for. */
    function visitComplete() {
      return seatedDone && (standingDone || !standingRequired());
    }

    function standingRequired() {
      return getFieldValue(FIELD_NAMES.standing_required) === '1';
    }

    /**
     * Close the visit, but only when it is actually finished.
     *
     * Marking it complete used to be the last line of both handlers, so a
     * standing measurement taken on its own closed the record with no seated
     * reading in it. Completion is now a question about the record rather than
     * about which button was last pressed.
     */
    function finish(lastMode) {
      if (visitComplete()) {
        setFieldValue(FIELD_NAMES.measurement_status, 'complete');
        measurementComplete = true;
        setStatus('success',
          standingDone ? 'Seated and standing assessment complete.'
                       : 'Seated assessment complete.');
      } else if (lastMode === 'standing' && !seatedDone) {
        setStatus('normal',
          'Standing done. A seated measurement is still needed to complete ' +
          'this visit.');
      }
      updateButtons();
    }

    if (ui.seated) {
      ui.seated.addEventListener('click', function () { takeMeasurement('seated'); });
    }

    if (ui.standing) {
      ui.standing.addEventListener('click', function () { takeMeasurement('standing'); });
    }

    /**
     * The one place that decides what is live.
     *
     * Every button is derived from the same three facts — connected, busy,
     * finished — so no path can leave a control stranded. Anything that changes
     * one of those facts calls this rather than reaching for a button itself.
     */
    /**
     * What the record still needs, in one line.
     *
     * The status line is about the last thing that happened; this is about
     * where the visit has got to. They answer different questions, and an
     * operator who has just seen "Standing done" still has to work out whether
     * anything remains — which is exactly the moment a visit gets submitted
     * half-finished.
     */
    function renderVisitState() {
      var state = visitStateText();
      var style = VISIT_STYLES[state.kind] || VISIT_STYLES.waiting;
      var painted = [];

      // Every block that has one, because the answer is about the record rather
      // than about a position — and an operator reading the standing block
      // should not have to scroll up to learn the visit is finished.
      for (var mode in blocks) {
        var el = blocks[mode].visit;
        if (!el || painted.indexOf(el) !== -1) continue;
        painted.push(el);

        el.style.background   = style.background;
        el.style.border       = style.border;
        el.style.color        = style.color;
        el.style.borderRadius = '8px';
        el.style.padding      = '10px 14px';
        el.style.fontWeight   = '600';
        el.style.textAlign    = 'center';
        el.innerText = state.text;
      }
    }

    function visitStateText() {
      if (!device) return { kind: 'waiting', text: 'Not connected to a BP+' };

      if (visitComplete()) {
        return {
          kind: 'complete',
          text: standingDone
            ? 'Complete — seated and standing recorded, ready to submit'
            : 'Complete — seated recorded, ready to submit',
        };
      }

      if (!seatedDone && !standingDone) {
        return { kind: 'incomplete', text: 'No measurement recorded yet' };
      }
      if (seatedDone && !standingDone) {
        return { kind: 'incomplete', text: 'Seated recorded — standing still needed' };
      }
      return { kind: 'incomplete', text: 'Standing recorded — seated still needed' };
    }

    function updateButtons() {
      // Completion does not lock the buttons. The operator is in the room and
      // the module is not: a reading that succeeded but is unusable — the
      // participant moved, the cuff slipped, the arm was talking — has to be
      // repeatable without reloading the page. `busy` is the only thing that
      // takes a control away.
      //
      // `features`, not just `device`: a port that opened but has not yet
      // answered `f` leaves a device object with nothing proven on the end of
      // it, and the operator must not be handed live Start buttons for it.
      var linked = !!device && !!features && !busy;

      // A BP+ that is not in AOBP mode measures something else. Suprasystolic
      // mode produces a central pressure waveform from one inflation — a
      // perfectly good measurement, and not the three-reading average this
      // study records. Taken by mistake it writes a number into seated_ave_sys
      // that no protocol produced, against a participant, and nothing
      // downstream can tell it apart from a real one afterwards.
      //
      // So the measurement is refused, not warned about. The device says which
      // mode it is in and can be told to change, which makes this the rare case
      // where a check at connect can be trusted for the whole visit.
      var ready = linked && deviceIsAobp();

      setEnabled(ui.seated,   ready);
      setEnabled(ui.standing, ready);
      relabel('seated',   ui.seated);
      relabel('standing', ui.standing);
      for (var mode in blocks) {
        setEnabled(blocks[mode].cancel, !!device && busy);
      }

      // Both gated on `linked`, not `ready`: Set AOBP mode is how the wrong
      // mode gets fixed, so gating it on being in the right mode already would
      // leave the operator with every control dead and no way out. Ping asks
      // whether the link is alive, which is a fair question in any mode.
      setEnabled(ui.setAobp,  linked && canSetAobpMode());
      setEnabled(ui.ping,     linked);

      renderVisitState();
    }

    /**
     * Whether the mode change is both possible and needed.
     *
     * Possible: the device reported a measureMode at all. That field arrives
     * with feature list 3.0, and a device that does not report one will not
     * accept MEASUREMODE in an `f` write either — so the read is the capability
     * test, rather than branching on the version attribute.
     *
     * Needed: it is not already in AOBP.
     */
    function canSetAobpMode() {
      return !!features && features.measureMode !== null && !deviceIsAobp();
    }

    if (ui.setAobp) {
      ui.setAobp.addEventListener('click', async function () {
        if (!device || !features) return;

        // An accepted write always reboots the device, once, and the reboot is
        // the only acknowledgement — there is no success code. Nothing else may
        // be attempted meanwhile.
        busy = true;
        updateButtons();
        setStatus('normal',
          'Setting the BP+ to AOBP mode. It will restart — do not unplug it.');

        try {
          features = await device.writeFeatures([
            [sdk.FeatureOption.measureMode, sdk.MeasureMode.bpPlusAobp],
          ]);

          if (deviceIsAobp()) {
            setStatus('success', 'BP+ is now in AOBP mode.');
          } else {
            // The write was accepted and the device came back, but not in the
            // mode asked for. Reporting success here would be a lie the first
            // measurement would expose.
            setStatus('error',
              'The BP+ restarted but reports ' + features.measureModeInfo.label +
              ', not BP+ AOBP. It may not support the AOBP protocol.');
          }
        } catch (error) {
          setStatus('error', 'Could not set AOBP mode: ' + describe(error));
          console.error('[AOBP]', error);
        } finally {
          busy = false;
          updateButtons();
        }
      });
    }

    /**
     * Confirm the link is live, and that the device on it is still usable.
     *
     * Nothing about a serial cable tells the page it has been unplugged: the
     * port stays open and the next command simply times out, which the operator
     * meets in the middle of a measurement. Two commands answer that cheaply —
     * `?` for the Terminal API version and `f` for the feature list — and
     * between them they re-check everything connect checked.
     */
    if (ui.ping) {
      ui.ping.addEventListener('click', async function () {
        if (!device) { setStatus('error', 'Please connect the BP+ first.'); return; }

        busy = true;
        updateButtons();
        setStatus('normal', 'Checking the BP+…');

        try {
          apiVersion = await device.readApiVersion();
          features   = await device.readFeatures();
          showDeviceInfo();

          // The operator has one question — can I measure now — and four
          // possible answers, each with a different next step. Versions are not
          // one of them: a nurse cannot act on a feature list number, and
          // putting it on the status line invites a call to say it out loud.
          // It goes to #device-info, which only an instrument written for a
          // technician provides.
          if (capabilityShortfall(features, apiVersion)) {
            setStatus('error',
              'This BP+ needs a software update before it can be used in this study.');
          } else if (!deviceIsAobp()) {
            setStatus('error', 'BP+ found, but it is not set up for this study.');
          } else {
            setStatus('success', 'BP+ device found and ready.');
          }
        } catch (error) {
          setStatus('error', 'No answer from the BP+. Check the cable, then try again.');
          console.error('[AOBP] ping failed', error);
        } finally {
          busy = false;
          updateButtons();
        }
      });
    }

    /**
     * The versions and mode, for a reader who can act on them.
     *
     * Absent from the visit instrument on purpose. The same module serves both,
     * and which one it is showing is decided by whether the instrument provides
     * this element rather than by a setting.
     */
    function showDeviceInfo() {
      if (!ui.info) return;
      if (!features) { ui.info.innerText = ''; return; }

      var newline = String.fromCharCode(10);
      ui.info.style.background   = '#f1f5f9';
      ui.info.style.border       = '1px solid #d8dee6';
      ui.info.style.borderRadius = '8px';
      ui.info.style.padding      = '10px 14px';
      ui.info.style.marginTop    = '10px';
      ui.info.style.fontFamily   = 'ui-monospace, Consolas, monospace';
      ui.info.style.fontSize     = '13px';
      ui.info.innerText = [
        'Device ' + features.deviceId,
        'Software ' + features.softwareVersion + ' · firmware ' + features.firmwareVersion,
        'Feature list ' + features.version + ' · Terminal API ' + (apiVersion || 'unknown'),
        'Mode ' + features.measureModeInfo.label,
      ].join(newline);
    }

    function wireCancel(mode) {
      var button = blocks[mode].cancel;

      once(button, async function () {
        if (!device) return;

        // Disabled immediately: the device answers a cancel with one F 02 and
        // one M 02, and a second `c` arriving between them has nothing left to
        // cancel. The measurement's own promise rejects with F 02, so the
        // status line and the buttons are restored by the handler that started
        // it — there is nothing to put right here.
        setEnabled(button, false);
        setStatus('normal', 'Cancelling…', currentMode);
        try {
          await device.cancel();
        } catch (error) {
          // A cancel that cannot be sent is not itself a measurement failure,
          // and the measurement will report whatever actually happened to it.
          console.warn('[AOBP] cancel could not be sent:', error.message);
        }
      });
    }

    wireCancel('seated');
    wireCancel('standing');

    /** Whether this position already has a reading stored. */
    function hasReading(mode) {
      return mode === 'seated' ? seatedDone : standingDone;
    }

    /**
     * "Start Seated BP" becomes "Repeat Seated BP" once seated has a reading.
     *
     * One button, saying what pressing it will do. It replaces a separate Repeat
     * button that sat beside Start doing exactly the same thing, which left the
     * operator two controls for one action and no way to tell them apart.
     *
     * Only the word is swapped, so whatever the instrument called the position
     * survives — "Start Seated BP" and "Start seated" both keep their wording,
     * and a label that never said "Start" is left alone rather than guessed at.
     */
    function relabel(mode, button) {
      if (!button || !startLabel[mode]) return;

      var wanted = hasReading(mode)
        ? startLabel[mode].replace(/\bStart\b/, 'Repeat')
        : startLabel[mode];

      if (button.textContent !== wanted) button.textContent = wanted;
    }

    setStatus('ready', 'Connect the BP+ to begin.', 'all');

    // Exposed so the test harness can drive the same code the survey runs.
    window.AOBP = {
      connect: connect,
      runMeasurement: runMeasurement,
      get device() { return device; },
      get lastMeasurement() { return lastMeasurement; },
      get lastClockSync() { return lastClockSync; },
      get features() { return features; },
      get sdk() { return sdk; },
      loadSdk: loadSdk,
      FIELD_NAMES: FIELD_NAMES,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function setEnabled(button, enabled) {
    if (button) button.disabled = !enabled;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Whether a dotted version is at least `minimum`.
   *
   * Returns null — not false — when the string cannot be read as a version, so
   * a device that reports something unexpected is treated as "cannot tell"
   * rather than "too old". Refusing to measure over an unparsable version
   * string would be the worse failure.
   */
  function atLeast(version, minimum) {
    if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version.trim())) {
      return null;
    }

    var have = version.trim().split('.').map(Number);
    var want = String(minimum).split('.').map(Number);

    for (var i = 0; i < Math.max(have.length, want.length); i++) {
      var a = have[i] || 0;
      var b = want[i] || 0;
      if (a > b) return true;
      if (a < b) return false;
    }
    return true;
  }

  /** How long the auto-advance waits. v1.0.1's fixed 3 s is the default. */
  function autoAdvanceSeconds(cfg) {
    var seconds = Number(cfg.autoAdvanceSeconds);
    return isFinite(seconds) && seconds >= 0 ? seconds : 3;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Where to import the SDK from.
   *
   * REDCap serves a module's static files from its own directory, so a path
   * relative to this script is right in the survey. The server can override it
   * (AOBP_CONFIG.sdkUrl) for the case where that is not true, and the test
   * harness sets it directly.
   */
  function sdkUrl() {
    var cfg = window.AOBP_CONFIG || {};
    if (cfg.sdkUrl) return cfg.sdkUrl;
    if (THIS_SCRIPT) return new URL('../sdk/index.js', THIS_SCRIPT).href;
    return '../sdk/index.js';
  }
})();
