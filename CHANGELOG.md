# Changelog

Releases are tagged `utas_aobp_integration-v<version>`, and the release workflow
refuses a tag whose version disagrees with `config.json` — because REDCap takes
the version from the installed directory name, and a ZIP whose contents
contradict its own name is the one mistake that reaches a production server and
stays there.

## 1.2.1 -- 2026-09-08

Two faults in the same dead end, both met by changing the measurement mode on
the device rather than with **Set AOBP mode**.

### The page now notices the BP+ restarting

Changing the mode reboots it. The USB device is the Prolific adapter rather than
the BP+, so nothing re-enumerates: Chrome fires no disconnect, the port stays
open, and the page went on believing a feature list read before the reboot. An
operator told the device was not in AOBP mode, who went and changed it, came
back to Start still disabled, no Connect button, and nothing to press.

`M 00` is the device announcing itself from the start, which only a restart
produces. The page listens for it, reads the device again, and says what it
found -- so a mode changed on the device takes effect without a reload.

### Ping no longer blames the cable for a fault in this page

`showDeviceInfo()` was called and never defined here. A ping therefore read the
Terminal API version, read the feature list, and then threw on its way to the
status line -- which was reported as *"No answer from the BP+. Check the cable,
then try again."* with both answers sitting in the trace.

It is defined now, and fills `#device-info` where an instrument provides one.
A failed check reports what actually happened rather than assuming the device is
at fault.

### Also

- The install instructions no longer open with `node tools/package.mjs`, which
  was removed in 1.2.0 along with the design it was built for.

Nothing in `sdk/` changed: still v1.3.0, verified against its manifest.

## 1.2.0 -- 2026-09-07

**The patient ID is now composed rather than being the record ID.** The device
writes it verbatim into the xml result file saved to the SD card, which is what
allows a card full of recordings to be reconciled back to REDCap records.

Four choices, `REDCAP-[record]-[instance]` by default: the record ID on its own,
a custom template, or nothing at all. `[record]`, `[instance]` and `[position]`
are replaced, and `:5` pads with leading zeros.

`[position]` is available and not in the default. A visit takes two recordings
against one record and one instance, but an AOBP result already carries
`bodyPosition` in its own XML, and the file says which it is.

An ID is never truncated. Shortening an identifier is how two participants come
to share one, which would undo the only thing the value is for -- an over-long
value is not sent at all, and the status line says why. The character rule comes
from the SDK rather than a copy kept here.

### Settings

Every setting now leads with a bold heading and follows it with an explanation,
matching the Uscom module. The two instrument settings are dropdowns of the
project's own instruments rather than free text: a misspelt instrument name is a
setting that silently does nothing.

`test/settings.html` renders `config.json` the way REDCap renders it. REDCap
treats a setting's `name` as HTML, and a default written as
`REDCAP-<record>-<instance>` reaches an administrator as `REDCAP--`. The same
rules run in `test/smoke.mjs`, and `config.json` must be plain ASCII -- a curly
apostrophe is invisible in a diff.

## 1.1.0 -- 2026-09-05

The version number restarts here. Until now the patch number was the commit
count, stamped into `dist/` by `tools/package.mjs` while `config.json` stayed at
`1.0.0` — so the repository never named the version it was, and the only record
of what a server was running was a folder name. Versions are now declared in
`config.json`, tagged, and built by a workflow that checks the two agree.
`dist/` and `tools/package.mjs` are gone with it.

**The recording is filed when it is taken, not when the page is saved.**

A REDCap form posts the value its File Upload field was *rendered* with, so a
page that rendered before the recording existed posts that emptiness back over
it — and an emptied file field is how REDCap deletes an edoc. That is what the
hold-until-save design was working around.

Answering it directly is smaller and safer: `save-xml` files the recording at
once, returns the document id, and the page writes it into the form. The submit
then posts back the value already stored and changes nothing, which is what
REDCap's own upload dialog does with the id it gets.

Gone with it: `redcap_save_record()`, the stash under `APP_PATH_TEMP`, and the
window in which the cleanup cron could take a recording nobody had saved yet.

**The save-xml endpoint is guarded.** It is declared in `no-auth-ajax-actions`,
because a survey respondent is not logged in, so it can be reached by someone
unauthenticated whose page this module did not write. What stood in front of it
was a test that the payload contained the substring `<BPplus` somewhere. Four
checks now do:

- the call must name the AOBP instrument, the only one the module writes to;
- the payload must be a string, since `strpos()` on an array is a TypeError;
- it must be shaped like a result document — starting as one and closing;
- it must fit 1 MB. A pressure wave is base64 of 16-bit samples at 200 Hz, so
  the largest result the hardware can produce — five 180-second determinations
  with a 30-second suprasystolic — is about 0.53 MB. The limit is loose above
  that deliberately: an abuser is no more deterred by a tight fit than by a
  generous one, while a tight fit rejects a measurement already taken.

`test/guards.php` runs the shipped class against stubs for the framework base
class and REDCap's file API, so every one of those is exercised rather than
reasoned about.

**Other fixes**

- `catch (Throwable $e)` caught nothing. `Throwable` is a global class and this
  file is namespaced, so the name resolved inside `AobpIntegration` where
  nothing of that name exists. `test/check-manifest.mjs` now refuses any class a
  namespaced file names without importing or qualifying it.
- **The measurement time is now a datetime.** The device writes ISO 8601 with no
  zone and REDCap wants a space where the `T` is. `seated_datetime` and
  `standing_datetime` had no validation, so the value stored as text and was not
  a date to REDCap — no picker, and no use in reports or date arithmetic. Only
  the separator moves; reparsing through a `Date` would put the browser's
  timezone between the device and the record.
- **REDCap's save controls are disabled while a measurement or an upload is in
  flight.**
- **A page with no save control is refused** rather than measured on. REDCap
  renders a survey response that way to a user without *Edit survey responses*.
  Judged on the save controls and not on the fields: every reading field here is
  `@READONLY`, so a test that looked at the fields would refuse every page.
- **The patient ID is sanitised by the SDK**, not by a copy of the rule kept
  here. SDK 1.3.0 relaxes it from letters-digits-hyphen to what the
  specification allows — printable ASCII minus comma, `<`, `&` and `>`. It is
  never truncated: shortening an identifier is how two participants come to
  share one.
- The stored-as-file marker carries `doc=`, which ties the row to the document
  in an export.

**Settings** now read as a bold name and an explanation, and the two instrument
settings are dropdowns of the project's own instruments rather than free text —
a misspelt instrument name is a setting that silently does nothing.

**The data dictionary needs re-importing** for the datetime validation. See
`data_dictionary/AOBPDEV_DataDictionary_2026-09-04_datetime.csv`.
