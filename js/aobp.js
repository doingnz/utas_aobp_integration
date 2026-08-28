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
  // supplied cable uses. The picker still lists every port, because a site with
  // a different cable must not be locked out by a filter.
  var PORT_FILTERS = [{ usbVendorId: 0x067B }];

  // How far the device clock may be out before it is quietly set to this
  // computer's. The measurement timestamp goes into the result XML, so a device
  // whose clock is wrong mislabels data that cannot be corrected afterwards.
  // Overridden per project with the AOBP_CONFIG.clockToleranceMinutes setting.
  var DEFAULT_CLOCK_TOLERANCE_MINUTES = 5;

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
    var lastMeasurement = null;
    var lastClockSync = null;
    var measurementComplete = false;

    setEnabled(ui.seated, false);
    setEnabled(ui.standing, false);

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

      // One read at connect. The device announces later changes itself, so
      // there is nothing to poll.
      features = await device.readFeatures().catch(function (error) {
        console.warn('[AOBP] no feature list:', error.message);
        return null;
      });

      if (features) {
        console.log('[AOBP] device ' + features.deviceId +
                    ', firmware ' + features.softwareVersion +
                    ', mode ' + features.measureModeInfo.label);
      }
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
      console.log('[AOBP] transport: ' + pick.reason);

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

      var measurement;
      try {
        measurement = await measure(mode);
      } catch (error) {
        setStatus('error', label + ': ' + describe(error));
        console.error('[AOBP]', error);
        return false;
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
          setEnabled(ui.seated, true);
          setEnabled(ui.standing, true);
        } catch (error) {
          device = null;
          setEnabled(ui.connect, true);
          setStatus('error', describe(error));
          console.error('[AOBP]', error);
        }
      });
    }

    if (ui.seated) {
      ui.seated.addEventListener('click', async function () {
        if (measurementComplete) { setStatus('success', 'Assessment already complete.'); return; }

        setEnabled(ui.seated, false);
        setEnabled(ui.standing, false);

        var ok = await runMeasurement('seated');
        if (!ok) { setEnabled(ui.seated, true); setEnabled(ui.standing, true); return; }

        if (getFieldValue(FIELD_NAMES.standing_required) === '1') {
          setStatus('normal',
            'Seated done. Stand the participant, then press Start standing.');
          setEnabled(ui.standing, true);
          return;                                  // the operator decides when
        }

        setFieldValue(FIELD_NAMES.measurement_status, 'complete');
        measurementComplete = true;
        setStatus('success', 'Seated assessment complete.');
      });
    }

    if (ui.standing) {
      ui.standing.addEventListener('click', async function () {
        setEnabled(ui.standing, false);
        setEnabled(ui.seated, false);

        var ok = await runMeasurement('standing');
        if (!ok) { setEnabled(ui.standing, true); return; }

        setFieldValue(FIELD_NAMES.measurement_status, 'complete');
        measurementComplete = true;
        setStatus('success', 'Standing assessment complete.');
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
