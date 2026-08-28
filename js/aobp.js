/**
 * AOBP Integration — the survey-page controller.
 *
 * This is a consumer of the BP+ SDK in `../sdk/`. Everything to do with the
 * wire protocol — framing, checksums, result codes, timeouts — lives there.
 * What is left here is the part that is specific to this study: which REDCap
 * fields to fill, which buttons drive it, and what the operator is told.
 *
 * The DOM contract, on the `aobp_visit` instrument:
 *
 *   #connect-bp-btn        starts the browser's serial port picker
 *   #start-seated-btn      seated measurement, then standing if required
 *   #start-standing-btn    standing measurement on its own
 *   #cancel-bp-btn         optional; live only while a measurement is running
 *   #set-aobp-mode-btn     optional; live only when the device is not in AOBP
 *                          mode and can be told to be
 *   #status-display        the single large status line
 *   #seated-results-panel  filled after each measurement
 *   #standing-results-panel
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

  // What a BP+ must report before it can take a seated or standing measurement.
  // Body position is the 5th parameter of `s`; older firmware answers F 14.
  var MIN_FEATURE_VERSION = '3.0';   // the feature schema carrying measureMode
  var MIN_API_VERSION     = '2.4';   // the command set accepting body position

  document.addEventListener('DOMContentLoaded', function () {
    start().catch(function (error) {
      console.error('[AOBP] failed to start', error);
    });
  });

  async function start() {
    var ui = {
      connect:  document.getElementById('connect-bp-btn'),
      seated:   document.getElementById('start-seated-btn'),
      standing: document.getElementById('start-standing-btn'),
      cancel:   document.getElementById('cancel-bp-btn'),
      setAobp:  document.getElementById('set-aobp-mode-btn'),
      status:   document.getElementById('status-display'),
      panels: {
        seated:   document.getElementById('seated-results-panel'),
        standing: document.getElementById('standing-results-panel'),
      },
    };

    if (!ui.connect && !ui.seated && !ui.standing) return;   // not our instrument

    var sdk = null;          // the imported module namespace
    var device = null;
    var features = null;     // the reply to `f`, read once at connect
    var apiVersion = null;   // the reply to `ver`, or null if it could not be read
    var lastMeasurement = null;
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

    function setStatus(kind, message) {
      console.log('[AOBP] ' + kind.toUpperCase() + ':', message);
      if (!ui.status) return;

      var style = STATUS_STYLES[kind] || STATUS_STYLES.normal;
      ui.status.style.background = style.background;
      ui.status.style.border     = style.border;
      ui.status.style.color      = style.color;
      ui.status.style.fontSize   = '24px';
      ui.status.style.fontWeight = '600';
      ui.status.style.textAlign  = 'center';
      ui.status.style.padding    = '18px';
      ui.status.innerText = message;
    }

    // ── REDCap fields ───────────────────────────────────────────────────────

    function setFieldValue(name, value) {
      if (!name) return;
      var field = document.querySelector('[name="' + name + '"]');
      if (!field) return;
      field.value = value === null || value === undefined ? '' : String(value);
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function getFieldValue(name) {
      var field = document.querySelector('[name="' + name + '"]');
      return field ? field.value : null;
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
      device = new api.BpPlusDevice(transport);

      device.on('warning', function (w) { console.warn('[AOBP]', w.message); });
      device.on('log', function (entry) {
        if (window.AOBP_CONFIG && window.AOBP_CONFIG.trace) {
          console.log('[AOBP] ' + (entry.dir === 'tx' ? '>' : '<'), entry.text);
        }
      });

      await device.connect();

      // device.connect() only opens the port — it sends nothing and waits for
      // nothing. The feature list is the first thing the device actually says,
      // so it is what proves a BP+ is on the other end at all.
      //
      // Deliberately not caught. Every BP+ answers `f`; silence means the port
      // opened onto something that is not a BP+ — the wrong COM port, or a
      // cable with nothing on the end. Reporting that as a connection would
      // hand the operator a green status line and two live buttons attached to
      // nothing.
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
      var panel = ui.panels[mode];
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

    function storeResult(mode, measurement) {
      var fields = FIELD_NAMES[mode];
      var bp = measurement.brachial;

      setFieldValue(fields.sys, bp.sys);
      setFieldValue(fields.dia, bp.dia);
      setFieldValue(fields.hr,  bp.pr);
      setFieldValue(fields.datetime,  measurement.timestamp);
      setFieldValue(fields.guid,      measurement.guid);
      setFieldValue(fields.device_id, measurement.deviceId);

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

      lastMeasurement = measurement;
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
        console.warn('[AOBP] the External Modules AJAX helper is not on this page.');
        return;
      }

      try {
        var reply = await ExternalModules.ajax('save-xml', { mode: mode, xml: xml });
        if (reply && reply.status === 'success') {
          console.log('[AOBP] stored ' + reply.filename + ' in ' + reply.field);
        } else {
          console.warn('[AOBP] the XML was not stored:', reply && reply.message);
        }
      } catch (error) {
        console.warn('[AOBP] the XML was not stored:', error);
      }
    }

    /** Turn an SDK error into something an operator can act on. */
    function describe(error) {
      if (!error) return 'The measurement failed.';

      // A BpPlusError already carries a sentence written for a person, and a
      // Table 5 code a script can branch on.
      if (error.code !== undefined && error.message) {
        if (sdk && error.code === sdk.ResultCode.cancelled) {
          return 'the measurement was cancelled at the device. Press start to try again.';
        }
        return error.message;
      }
      return error.message || String(error);
    }

    // ── Buttons ─────────────────────────────────────────────────────────────

    if (ui.connect) {
      ui.connect.addEventListener('click', async function () {
        setEnabled(ui.connect, false);
        setStatus('normal', 'Select the BP+ serial port…');
        try {
          await connect();
          setStatus('success', 'BP+ connected' +
            (deviceIsAobp() ? '' : ' — the device is NOT in AOBP mode'));
          ui.connect.style.display = 'none';
          updateButtons();
        } catch (error) {
          device = null;
          setEnabled(ui.connect, true);
          setStatus('error', describe(error));
          console.error('[AOBP]', error);
        }
      });
    }

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
      if (measurementComplete) {
        setStatus('success', 'Assessment already complete.');
        return;
      }
      if (!device) {
        setStatus('error', 'Please connect the BP+ first.');
        return;
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
    function updateButtons() {
      var ready = !!device && !busy && !measurementComplete;

      setEnabled(ui.seated,   ready);
      setEnabled(ui.standing, ready);
      setEnabled(ui.cancel,   !!device && busy);
      setEnabled(ui.setAobp,  ready && canSetAobpMode());
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

    if (ui.cancel) {
      ui.cancel.addEventListener('click', async function () {
        if (!device) return;

        // Disabled immediately: the device answers a cancel with one F 02 and
        // one M 02, and a second `c` arriving between them has nothing left to
        // cancel. The measurement's own promise rejects with F 02, so the
        // status line and the buttons are restored by the handler that started
        // it — there is nothing to put right here.
        setEnabled(ui.cancel, false);
        setStatus('normal', 'Cancelling…');
        try {
          await device.cancel();
        } catch (error) {
          // A cancel that cannot be sent is not itself a measurement failure,
          // and the measurement will report whatever actually happened to it.
          console.warn('[AOBP] cancel could not be sent:', error.message);
        }
      });
    }

    setStatus('ready', 'Connect the BP+ to begin.');

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
