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
| Desktop Chrome / Edge | Web Serial |
| Android Chrome | WebUSB — Android has no Web Serial |

The module asks the SDK which is available and uses it, so the operator sees the
same buttons either way. One consequence on Android: the cable must be a
**Prolific PL2303**, because WebUSB drives the adapter chip directly and that is
the driver the SDK ships. On desktop the operating system supplies the driver, so
any adapter works.

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
| Store the raw measurement XML as a file | off | See **The raw XML** |
| Log every serial line to the browser console | off | Troubleshooting only |

---

## The instrument

The module looks for these elements on the AOBP instrument:

| Element | Purpose |
|---|---|
| `#connect-bp-btn` | Opens the browser's serial port picker |
| `#start-seated-btn` | Seated measurement |
| `#start-standing-btn` | Standing measurement |
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
| Raw XML | `seated_raw_xml_text` | `standing_raw_xml_text` |

Two control fields: `sys_standing_required` — set to `1` to ask for a standing
measurement after the seated one — and `sys_measurement_status`, which the module
sets to `complete` when the visit is done.

`seated_af` and `standing_af` are radios, so the module clicks the option
(`opt-<field>_1` / `_0`) rather than setting a value. That is the only way REDCap
records the choice.

### Operator flow

Connect, then **Start seated**. If `sys_standing_required` is `1` the module
stops and asks for the participant to be stood up; **Start standing** takes the
second measurement when the operator is ready. Nothing runs on a timer.

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

That is more than a REDCap **text field** holds. The module writes the field and
logs a console warning past 60,000 characters, but the place to keep the XML is a
file:

1. Add file-upload fields named `seated_raw_xml` and `standing_raw_xml`.
2. Tick **Store the raw measurement XML as a file on the record**.

The page then calls the module's `save-xml` AJAX action after each measurement,
and the file lands on the record through `\REDCap::saveFile()`. The External
Modules framework authenticates that call and scopes it to the calling project.

This path needs a REDCap instance to exercise. Confirm on your installation
whether the `save-xml` action must be declared for use from a survey page, where
the respondent is not a logged-in user. The measurement itself does not depend on
it: a failure is logged, and the numeric fields are already filled by then.

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

The module offers one hook for this and nothing else: if `window.AOBP_TRANSPORT`
is a function it is asked for the transport, which is how the harness substitutes
the simulator. REDCap never sets it.

### Testing on a tablet

The device APIs need a secure context, so a tablet cannot use a plain
`http://192.168.x.x` address. `index.html` and `web.config` let this folder be
served straight from an HTTPS web root: the landing page reports what the browser
can do — on Android it should read `Web Serial no · WebUSB yes · Android` — and
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
test/chart.umd.min.js   Chart.js, used by the harness only
```

`sdk/` is a copy of the BP+ JavaScript SDK, carried here because REDCap serves
only a module's own directory. Do not edit it in place — replace the folder to
take a new version.

---

## Acknowledgement

The AOBP visit instrument, the field design and the operator flow this module
follows are the work of **Oliver Stanesby**, Menzies Institute for Medical
Research, University of Tasmania, who first brought the BP+ into a REDCap
survey.

