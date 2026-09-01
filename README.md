# AOBP Integration

A REDCap external module that records an automated office blood pressure (AOBP)
measurement from a **Uscom BP+** directly into a survey.

The operator connects the device once and presses a button per measurement; the
readings land in the record's fields. Nothing is typed by hand, and nothing is
transcribed from the device screen.

---

## How it works

The BP+ is on the **operator's** serial cable, not on the server, so the whole
measurement happens in the browser. The module puts the BP+ JavaScript SDK on the
survey page; the SDK owns the device — framing, checksums, result codes,
timeouts, the AOBP protocol — and `js/aobp.js` owns what is specific to this
study: which fields to fill, and what the operator is told.

Nothing about a measurement passes through PHP unless the raw XML is being stored
as a file.

---

## Requirements

| | |
|---|---|
| REDCap | External Modules framework version 15 |
| Browser | **Chrome or Edge.** Firefox, Safari and iOS implement none of the device APIs |
| Page | HTTPS — the browser refuses device access on an insecure origin |
| Device | Uscom BP+ on a USB cable |

Desktop and Android tablets both work, by different routes:

| | How the cable is reached |
|---|---|
| Desktop Chrome / Edge | WebSerial |
| Android Chrome | **WebUSB**, always — see below |

### Android and WebSerial — read before changing the transport logic

Chrome 151 on Android reports `navigator.serial`, so feature detection alone
concludes WebSerial is available. It is, but **its port list is not the USB
cable.** It enumerates Bluetooth SPP devices. Measured on Chrome
`151.0.7922.173`, same build on both:

| Device | WebSerial picker shows | Works over |
|---|---|---|
| Galaxy S23 Ultra | paired Bluetooth devices — car kits, headsets — no cable | WebUSB only |
| Galaxy Tab S10 FE | the cable, but with no USB vendor id | WebUSB, and unfiltered WebSerial |

Two consequences, both already handled — the first in the SDK, the second in
`js/aobp.js`:

1. **On Android the cable goes through WebUSB**, whatever WebSerial claims.
   `recommendedTransport()` in `sdk/transports/detect.js` checks Android before
   WebSerial rather than after it. The SDK's older rule — WebSerial if the
   browser has it — predates Android having it at all, and the devices above
   disproved it.

   The Android flag itself had to be fixed to make that work. `isAndroid()`
   returned on `userAgentData.platform` and never reached its own UA-string
   fallback, so Chrome's **"Desktop site"** mode — the default on some Samsung
   tablets, and which reports `platform: "Linux"` — made both devices claim to
   be desktops. Every check is now positive-only, and `describeEnvironment()`
   also exposes `handheld`: a touch screen with no fine pointer, which is what
   survives desktop-site mode.

   | Chrome mode | `uaData.platform` | `uaData.mobile` | `android` | `handheld` |
   |---|---|---|---|---|
   | Desktop site on | `Linux` | `false` | yes, via touch | **yes** |
   | Desktop site off | `Android` | `false` | yes | **yes** |

   `uaData.mobile` is `false` in both rows and is *not* a bug: UA-CH `mobile`
   means phone-shaped, and a tablet is correctly not mobile. Any rule built on it
   fails on the exact device that has to work, which is why the last resort is
   the touch test — and why a touch laptop, reporting a fine pointer as well,
   correctly stays on WebSerial.

   `js/aobp.js` carries no platform logic of its own. It calls
   `recommendedTransport()` and follows the answer.

2. **`PORT_FILTERS` is `null`.** A `requestPort()` filter on the Prolific vendor
   id matches nothing on Android even with a genuine PL2303GT
   (`0x067B:0x23A3`) attached and working, because the ports on offer are not
   USB ports and carry no USB ids. The picker reports "No compatible device
   found", which reads as a broken cable. Do not "tighten" this.

Because WebUSB drives the adapter chip directly, the cable on Android must be a
**Prolific PL2303** — that is the only driver the SDK ships. On desktop the
operating system supplies the driver, so any adapter works.

The operator sees the same buttons either way; only the picker behind **Connect
BP+** differs — a port list on desktop, a USB device list on a tablet.

---

## Installing

1. Copy this folder into REDCap's `modules/` directory as
   `utas_aobp_integration_v1.0.0` — REDCap takes the version from the directory
   name.
2. Enable it on the project.
3. Set the instrument names below if they are not `aobp_visit` and `info`.

---

## Project settings

| Setting | Default | What it does |
|---|---|---|
| Instrument that carries the AOBP controls | `aobp_visit` | Where the buttons live |
| Instrument that uses the collapsible information panels | `info` | Optional, for `js/info.js` |
| Set the device clock when it is out by more than *n* minutes | 5 | See **The device clock** |
| Show warnings on measurements that succeeded | off | The device retries and recovers; see below |
| Store the raw measurement XML as a file | off | See **The raw XML** |
| Log every serial line to the browser console | off | Troubleshooting only |
| **TESTING ONLY — simulated BP+** | off | See **Testing without a device** |

---

## Testing without a device

**TESTING ONLY — simulated BP+** takes measurements from the SDK's built-in
simulator instead of a real device, so the survey, the AJAX call, the file upload
and the record can all be exercised where there is no BP+ and no cable. That is
most of what needs testing, and none of it involves the device.

Everything downstream of the transport runs exactly as it does for real, which is
the point of the setting and also its danger: **the readings are invented**, and
the simulator answers with a plausible device id (`015D90DE1A0000DA`). Two things
follow, both automatic:

- The page shows a red banner above the first block — *"SIMULATED BP+ — no
  device is connected and these readings are fabricated"* — in its own element,
  because the status line is rewritten by every step of every measurement.
- Every record is written with `SIMULATED-` in front of the device id, so an
  export identifies fabricated rows without anyone having to remember. Whoever
  reads it later was not in the room.

It runs **fast**, not lifelike: a seated measurement takes a couple of seconds.
Nobody testing a file upload should have to wait out a five-minute rest period to
reach it. The module also puts the simulator in **AOBP mode** — it defaults to
plain BP+, and a BP+ that is not in AOBP mode has Start disabled by design, which
is right for a real device and a dead end for a simulated one.

---

## The instrument

The module looks for these elements on the AOBP instrument:

| Element | Purpose |
|---|---|
| `#connect-bp-btn` | Opens the browser's serial port picker |
| `#start-seated-btn` | Seated measurement |
| `#start-standing-btn` | Standing measurement |
| `#cancel-bp-btn` | Optional. Cancels the measurement in progress |
| `#set-aobp-mode-btn` | Optional. Puts the device into BP+ AOBP mode |
| `#ping-bp-btn` | Optional. Confirms the link is live and the device still usable |
| `#visit-state` | Optional. What the record still needs, and whether it may be submitted |
| `#alerts-display` | Optional. What the device said was wrong, in its own words |
| `#device-info` | Optional. Versions and mode, for a technical instrument |
| `#status-display` | The single large status line |
| `#seated-results-panel` | Filled after the seated measurement |
| `#standing-results-panel` | Filled after the standing measurement |

and fills these fields:

| Value | Seated | Standing |
|---|---|---|
| Systolic | `seated_ave_sys` | `standing_ave_sys` |
| Diastolic | `seated_ave_dia` | `standing_ave_dia` |
| Heart rate | `seated_ave_hr` | `standing_ave_hr` |
| Irregular rhythm | `seated_af` | `standing_af` |
| Timestamp | `seated_datetime` | `standing_datetime` |
| Measurement GUID | `seated_guid` | `standing_guid` |
| Device ID | `seated_bpplus_device_id` | `standing_bpplus_device_id` |
| Signal-to-noise ratio | `seated_snr` | `standing_snr` |
| Raw XML | `seated_raw_xml_text` | `standing_raw_xml_text` |

One control field: `sys_standing_required` — set to `1` to ask for a standing
measurement after the seated one. Completion is not written by the module; the
dictionary derives it with the `sys_measurement_complete` calc, from the readings
themselves, so there is one answer rather than two that can disagree.

`seated_af` and `standing_af` are radios, so the module clicks the option
(`opt-<field>_1` / `_0`) rather than setting a value. That is the only way REDCap
records the choice.

### Starting a measurement on the device itself

A BP+ has its own Start button, and a measurement begun there carries no patient
ID and belongs to no record. The device stores it all the same, so it is not
harmless: it leaves an unattributed reading in the device's file list, taken
outside the protocol.

While connected and not measuring, the module watches the device's mode. Walking
into the AOBP menu (`M 23`) is reported to the operator; a measurement actually
starting (`M 22` countdown, or `M 03`) is cancelled, once per episode. The
module's own measurements are excluded by state rather than by timing, so the
identical modes that follow its own `s` command pass through untouched.

The SDK provides this as `new BpPlusDevice(transport, { hostStartedOnly: true })`
and it is off by default there — a tool that watches a device should not
interfere with it — but every measurement in this study has to come from the
survey page, so the module turns it on.

### A warning on a measurement that worked

The NIBP module retries a determination it could not finish, up to three times.
When a later attempt succeeds it records the good values and **leaves the failed
attempt's `<Alert>` in place**, so a perfectly good reading can carry what looks
like an error.

Severity is therefore contextual rather than lexical. The same alert text means:

| On a determination that | Shown as |
|---|---|
| produced values inside the device's `<bpRange>` | amber — recovered |
| produced nothing usable | red — a real failure |

The alerts are shown, not stored. An alert needs the determination it sits on to
mean anything, and a field holding one without that context asks a researcher to
invent rules for reading it; the retained XML holds both properly. **Hide
warnings on measurements that succeeded** decides whether the operator sees the
amber case: it is a real
signal — a participant needing two attempts every visit, a cuff failing
intermittently — but it is also a warning over a good reading, which invites a
repeat nobody needs. Off by default, so the warning is shown.

See also task 25 in the BP+ knowledge base, which is the firmware side of this.

### Operator flow

Connect, then **Start seated**. If `sys_standing_required` is `1` the module
stops and asks for the participant to be stood up; **Start standing** takes the
second measurement when the operator is ready. **Nothing runs on a timer.** A
timed advance existed until 2026-09-01, inherited from v1.0.1: the cuff inflated
three seconds after the seated measurement whether or not the participant was
upright and settled. A measurement that starts before the person is standing is
not a standing measurement, and nobody at the study knew the timer was there.

Completing a visit does not lock the buttons. **Start seated** and
**Start standing** stay live so a reading
that succeeded and is nevertheless unusable — the participant moved, the cuff
slipped — can be taken again without reloading the page. A repeat replaces the
stored reading for that position. Only a measurement actually in progress takes
the buttons away.

If the instrument carries a `#cancel-bp-btn`, it is live only while the cuff is
inflating and stops the measurement at the device — `c` is the one command the
BP+ accepts mid-measurement. The measurement then fails the way any other device
failure does, the status line says so, and the buttons re-enable so it can be
repeated. The element is optional: without it the module behaves exactly as
before.

---

## The measurement

### Body position

Body position is the 5th parameter of the device's `s` command, and the device
records it in the result XML — so a seated measurement is `bodyPosition="seated"`
in the stored file and a standing one is `"standing"`. That is what makes the two
visits distinguishable in the data itself, rather than only in the field names.

The device must be in **BP+ AOBP** mode (`DeviceMeasurementMode` 5), or it answers
`F 14` to a body position. The module reads the feature list once at connect and
only sends AOBP parameters when the device reports AOBP. If it does not, the
status line says so:

> BP+ connected — the device is NOT in AOBP mode

Worth checking before the first participant: it is the difference between an AOBP
protocol and a single reading.

### Patient ID

The record ID is sent to the device as the patient ID, so the measurement
identifies itself in the XML. The device accepts letters, digits and hyphens;
anything else becomes a hyphen rather than costing an `F 14` at the start of a
measurement.

### The device clock

The measurement timestamp in the result XML comes from the **device's** clock,
not the browser's, and a BP+ that has been off charge drifts. Nothing else in the
record says when a measurement was really taken, so a wrong clock mislabels data
in a way that cannot be corrected afterwards.

Before every measurement the module reads the device clock, compares it with the
computer's, and sets it when the difference is beyond the threshold — 5 minutes
by default. A device that is close enough is left alone, so the check costs one
line on the wire.

It is silent. The operator is mid-visit and the clock is not their problem, so it
goes to the browser console:

```
[AOBP] clock: The device clock was out by 1799 s, so it was set.
[AOBP] clock: The device clock is within tolerance.
```

A failure there is swallowed deliberately. A device that will not accept a time
is still a device that can measure, and refusing to measure over it is the worse
outcome for a participant who is already seated.

### Failures

Every device failure arrives as a `BpPlusError` carrying the result code, its
firmware name, and a sentence written for a person. The status line shows it and
the buttons re-enable, so a cancelled or failed measurement can simply be
repeated.

---

## The raw XML

A full AOBP result runs past **100 kB**, because of the base64 cuff-pressure
recordings the device keeps:

```
seated_raw_xml_text    ≈ 125,000 characters
standing_raw_xml_text  ≈ 103,000 characters
```

REDCap keeps only the first part of a value that long, so a text field holds a
fragment of an XML document formatted to look like a whole one — which reads as
data. The place to keep the XML is a file:

1. Add file-upload fields named `seated_raw_xml` and `standing_raw_xml`.
2. Tick **Store the raw measurement XML as a file on the record**.

The page then calls the module's `save-xml` AJAX action after each measurement.
Three things have to line up, and each was wrong here at some point:

**The call.** There is no global ajax helper. A page reaches its module through
the framework's *JavaScript module object*, which the module publishes with
`initializeJavascriptModuleObject()`; this module puts it on the page as
`window.AOBP_MODULE`, and `js/aobp.js` calls `AOBP_MODULE.ajax('save-xml', …)`.

**The declaration.** An action must be declared in `config.json` for the context
it is called from. A survey respondent is not logged in, so `save-xml` appears in
both lists — `no-auth-ajax-actions` for the survey, `auth-ajax-actions` for a
coordinator opening the same instrument as a data-entry form.

**The saving, which is two steps.**

```php
$docId = \REDCap::storeFile($tmpFile, $project_id, $filename);
\REDCap::addFileToField($docId, $project_id, $record, $field, $event_id, $repeat_instance);
```

`storeFile()` copies the bytes into REDCap's edoc store and returns a doc id, or
0. That gets the file onto the server and nowhere near the participant. It is
`addFileToField()` that puts it on the record, and it is the step that makes the
file visible on the form and downloadable afterwards. **The instance is not
optional here:** `aobp_visit` repeats, and a file filed without one lands on the
first instance whatever visit it came from.

`\REDCap::saveFile()` is not a REDCap method. This module called it, inherited
from `aobp_integration_v1.0.1`, and it would have failed with *undefined method*
the first time it ran.

**What the text field then holds.** A marker, and never the XML — the raw XML is
not written to the field at all while file storage is on:

```
stored-as-file field=seated_raw_xml filename=1001_inst1_seated_aobp.xml
  bytes=125768 sha256=6820f666… at=2026-08-31T23:59:01.123Z
```

The digest is over the bytes that were sent, so the file on the record can be
checked against what the device produced rather than taken on trust.

If the upload fails the field says that instead, with the same length and digest:

```
not-stored field=seated_raw_xml bytes=125768 sha256=b920b403… at=…
```

so a record never reads as a measurement that produced no recording when in fact
one was lost.

**With file storage off** the field holds the XML itself — reduced, because whole
will not fit. A text field holds 65,535 bytes and an AOBP result is twice that,
so the choice is not between whole and reduced but between reduced and
truncated, and a document cut off mid-element is worth nothing.
`sdk.minimalXml()` drops the waveform arrays and keeps everything else. It works
from a **drop list**, not a keep list, so anything a later firmware adds survives
by default — which is what a compact archive of a format still in development
needs.

Gone: `<RawPressureWave>` and `<NibpDetailedData>` from each determination, and
inside `<Result>` the bulk arrays — `sBaseLined`, `cEstimate`, `baEstimate`, the
two `*PulsePointsIndexes` that index into them, and `infraDiastolicFiltered` with
`infraDiastolicBeatStartIdxs`. The last two are listed for a firmware that does
not exist yet: nothing records the infradiastolic wave while AOBP is enabled, so
no file has them, and naming them now means a reduced file will not quietly grow
by another full rhythm strip the day one does.

Kept: `sAveragePulse` and `cAveragePulse` — arrays, but the *averaged* pulse
rather than a recording, and the shape every derived value was computed from, at
2.7 kB; `MeasDataLogger` entire, including the suprasystolic and cuff recordings;
every determination's Sys/Dia/Map/Pr with its timestamp, alert and motion flag;
and all 37 derived values in `<Result>` — SNR, sPRV, cSys, cDia, cAIx, cSEVR and
the rest — with `version` and `algorithm_revision` on the element. That last pair
matters: they record *which* algorithm produced the values, and a later
recomputation would use a later revision with nothing to say the two differ.

Measured on a real standing AOBP: **105,388 bytes becomes 17,138**, comfortably
inside a text field.

**When it fails.** The measurement itself is safe: the numbers are in their
fields before the upload is attempted. The recording is not — it exists nowhere
but the browser tab until it is uploaded, and dies with the page. So a failure
is not a console warning: the operator is told, and a **Resend recording** button
appears, which retries without asking the participant to sit through another
measurement.

One thing still needs a REDCap instance to settle: whether `$record` is
populated mid-survey. A file cannot attach to a record that does not exist, and
on a survey the record is created when the first page is submitted. The module
says so plainly rather than failing obscurely — *"This survey has no record yet,
so the recording cannot be filed. Save the page, then press Resend recording."*

---

## Reacting to a measurement

After each measurement, once the fields are filled:

```js
document.addEventListener('aobp:measurement', e => {
  e.detail.mode;         // 'seated' | 'standing'
  e.detail.measurement;  // the SDK's BpPlusMeasurement
});
```

Everything the SDK exposes is on `e.detail.measurement` — the individual
readings, signal quality, and the decoded cuff-pressure trace.

---

## Test harness

`test/harness.html` reproduces the AOBP instrument — the same element IDs, one
input per field — and loads **`js/aobp.js` unmodified**. The connect,
feature-read and measure paths it exercises are the ones the survey runs; only
the surrounding page is different. It needs no REDCap.

```bash
python -m http.server 8080
```

then open <http://localhost:8080/test/harness.html>. A server is required: ES
modules and the device APIs both refuse to run from `file://`.

Choose **Simulator** to work with no hardware, or **Real BP+ over serial** to
drive a device. It shows:

- every REDCap field as the module leaves it, which is what REDCap would save;
- conformance checks on each measurement — checksum, whether the numbers reached
  the fields intact, whether the irregular-rhythm radio matches `sPRV`, and
  whether the device recorded the body position it was asked for;
- the raw cuff-pressure trace, decoded from the XML, which is the proof that the
  result was understood rather than merely parsed;
- the serial trace, every line in and out;
- the SDK self-test, on a button.

There is also a headless check that needs no browser and no device:

```bash
npm install --no-save jsdom
node test/smoke.mjs
```

It loads `js/aobp.js` against a stand-in instrument and fails if the module does
not start — `node --check` only parses, and a value read before it was assigned
is exactly the fault that once shipped a build with the whole module dead on
load. It also covers the SDK's judgement on whether a result is a reading at
all. The jsdom half is skipped when jsdom is absent; the rest always runs.

The module offers one hook for this and nothing else: if `window.AOBP_TRANSPORT`
is a function it is asked for the transport, which is how the harness substitutes
the simulator. REDCap never sets it.

### Testing on a tablet

The device APIs need a secure context, so a tablet cannot use a plain
`http://192.168.x.x` address. `index.html` and `web.config` let this folder be
served straight from an HTTPS web root: the landing page reports what the browser
can do — on both Galaxy devices tested it reads `WebSerial yes · WebUSB yes ·
Bluetooth yes · Android`, and the WebSerial "yes" is the misleading one
described above — and
links to the harness.

`web.config` refuses to serve the `.php` files and disables client caching, so a
stale copy on the tablet cannot masquerade as a failed deployment.

---

## Layout

```
config.json             module manifest
AobpIntegration.php     survey hook and the save-xml AJAX action
js/aobp.js              the survey page controller — a consumer of the SDK
js/info.js              collapsible information panels
sdk/                    the BP+ JavaScript SDK
index.html              landing page, for serving the harness over HTTPS
web.config              IIS rules for that
test/harness.html       the test harness
test/smoke.mjs          does the module still start, and is a result a reading
test/chart.umd.min.js   Chart.js, used by the harness only
```

`sdk/` is a copy of the BP+ JavaScript SDK, carried here because REDCap serves
only a module's own directory. Do not edit it in place — replace the folder to
take a new version.

---

## Who to contact

| | |
|---|---|
| The instrument, the study, the REDCap project | **Oliver Stanesby**, Menzies Institute for Medical Research, University of Tasmania — <oliver.stanesby@utas.edu.au> |
| The module, the BP+ SDK, the device | **Richard Scott**, Uscom Ltd |

The AOBP visit instrument, the field design and the operator flow this module
follows are Oliver's work; he first brought the BP+ into a REDCap survey. Both
authors are listed in `config.json`, which is where REDCap reads them from for
the module list.

