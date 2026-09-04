<?php

namespace AobpIntegration;

use ExternalModules\AbstractExternalModule;
use Exception;
use Throwable;

/**
 * AOBP Integration.
 *
 * Puts the BP+ SDK on the survey page and tells it which record it is filling.
 * Everything else happens in the browser: the device is on the operator's
 * serial port, not on the server, so no part of the measurement passes through
 * PHP unless the raw XML is being stored as a file.
 *
 * The instrument names are project settings rather than constants, so a project
 * that names its instruments differently does not need the module edited.
 */
class AobpIntegration extends AbstractExternalModule
{
    /** Used when the project setting is blank. */
    private const DEFAULT_AOBP_INSTRUMENT = 'aobp_visit';
    private const DEFAULT_INFO_INSTRUMENT = 'info';

    /**
     * The largest recording save-xml will accept.
     *
     * Measured, not guessed. A pressure wave is base64 of 16-bit samples at
     * 200 Hz, so 8/3 of a byte per sample:
     *
     *   single suprasystolic result                          0.08 MB
     *   5-determination AOBP, as recorded                    0.13 MB
     *   5 x 75 s, the longest the device records today       0.25 MB
     *   5 x 180 s with a 30 s suprasystolic, the most the
     *     hardware could ever produce                        0.53 MB
     *
     * 1 MB is loose above that on purpose. The limit exists to stop an
     * unauthenticated endpoint being used to store arbitrary files, and an
     * abuser is no more deterred by a tight fit than by a generous one -- while
     * a tight fit rejects a measurement already taken on a participant.
     */
    private const MAX_RECORDING_BYTES = 1048576;

    public function redcap_survey_page_top(
        $project_id,
        $record,
        $instrument,
        $event_id,
        $group_id,
        $survey_hash,
        $response_id,
        $repeat_instance
    ) {
        if ($instrument === $this->infoInstrument()) {
            $this->emitScript('js/info.js');
        }

        if ($instrument === $this->aobpInstrument()) {
            $this->emitAobpConfig($project_id, $record, $event_id, $repeat_instance);

            // The framework's own JavaScript object, and the only supported way
            // to reach redcap_module_ajax() from a page. It carries the module
            // prefix and the survey's CSRF token, which a bare POST does not.
            // The page finds it at window.AOBP_MODULE.
            echo $this->initializeJavascriptModuleObject();
            echo '<script>window.AOBP_MODULE = '
                . $this->getJavascriptModuleObjectName() . ';</script>' . "
";

            $this->emitScript('js/aobp.js');
        }
    }

    /**
     * Store one measurement's raw XML as a file on the record.
     *
     * Reached from the page with AOBP_MODULE.ajax('save-xml', payload).
     * The framework authenticates the call and supplies $project_id, so unlike
     * a bare POST endpoint this cannot be aimed at another project.
     *
     * Off by default: see the "Store the raw XML as a file" project setting.
     * The measurement itself does not depend on it.
     */
    public function redcap_module_ajax(
        $action,
        $payload,
        $project_id,
        $record,
        $instrument,
        $event_id,
        $repeat_instance,
        $survey_hash,
        $response_id,
        $survey_queue_hash,
        $page,
        $page_full,
        $user_id,
        $group_id
    ) {
        if ($action !== 'save-xml') {
            return ['status' => 'error', 'message' => 'Unknown action.'];
        }

        if (!$this->getProjectSetting('aobp-save-xml-file')) {
            return ['status' => 'error', 'message' => 'Storing the XML as a file is not enabled for this project.'];
        }

        // This action is declared in no-auth-ajax-actions, because a survey
        // respondent is not logged in. So everything below assumes the caller is
        // unauthenticated and possibly not the module's own page: these checks
        // are what stands between a survey and an endpoint that writes files.
        //
        // The instrument first. The module only puts its JavaScript on the AOBP
        // instrument, so a call naming anything else did not come from a page
        // this module wrote. Logged with the value received, because if the
        // framework ever supplies this differently the symptom is that filing
        // stops entirely, and the log is what says why in one look.
        if ($instrument !== $this->aobpInstrument()) {
            $this->log('AOBP recording refused', [
                'reason'     => 'not the AOBP instrument',
                'instrument' => (string) $instrument,
                'record'     => (string) $record,
            ]);
            return ['status' => 'error', 'message' => 'This is not the AOBP instrument.'];
        }

        $mode = $payload['mode'] ?? '';
        $xml  = $payload['xml'] ?? '';

        if ($mode !== 'seated' && $mode !== 'standing') {
            return ['status' => 'error', 'message' => 'Unknown measurement mode.'];
        }

        // A payload is whatever was posted, so it can be an array or a number as
        // easily as a string. strpos() on an array is a TypeError in PHP 8.
        if (!is_string($xml)) {
            return ['status' => 'error', 'message' => 'That does not look like a BP+ measurement.'];
        }

        // Shaped like a result document, not merely containing the word. A
        // substring test alone would accept any payload with "<BPplus" buried
        // anywhere in it, which makes this a general-purpose place to put a file.
        $trimmed = ltrim($xml);
        $startsRight = strncmp($trimmed, '<?xml', 5) === 0 || strncmp($trimmed, '<BPplus', 7) === 0;

        if (!$startsRight || strpos($xml, '<BPplus') === false || strpos($xml, '</BPplus>') === false) {
            return ['status' => 'error', 'message' => 'That does not look like a BP+ measurement.'];
        }

        // A pressure wave is base64 of 16-bit samples at 200 Hz, so the largest
        // result the hardware can produce -- five 180-second determinations with
        // a 30-second suprasystolic -- is about 0.53 MB. The limit is loose above
        // that deliberately: an abuser is no more deterred by a tight fit than a
        // generous one, while a tight fit rejects a measurement already taken on
        // a participant.
        if (strlen($xml) > self::MAX_RECORDING_BYTES) {
            $this->log('AOBP recording refused', [
                'reason' => 'over the size limit',
                'record' => (string) $record,
                'bytes'  => strlen($xml),
                'limit'  => self::MAX_RECORDING_BYTES,
            ]);
            return ['status' => 'error', 'message' => 'Recording exceeds the maximum supported size.'];
        }

        $field = $mode === 'standing' ? 'standing_raw_xml' : 'seated_raw_xml';

        // A file cannot be attached to a record that does not exist. On a survey
        // the record is created when the first page is submitted, so a
        // measurement taken before that has nowhere to go — said plainly here,
        // because the page can offer Resend once the record exists.
        if ((string) $record === '') {
            return [
                'status'  => 'error',
                'message' => 'This survey has no record yet, so the recording cannot be '
                           . 'filed. Save the page, then press Resend recording.',
            ];
        }

        $filename = $this->recordingFilename($record, $repeat_instance, $mode);

        // storeFile() takes a path, so the bytes have to be on disk for the
        // length of these two calls. Written and removed inside this one
        // request, unlike the edoc it becomes.
        $tmp = tempnam($this->tempDir(), 'aobp_');
        if ($tmp === false || file_put_contents($tmp, $xml) === false) {
            $this->log('AOBP recording failed', [
                'record' => $record, 'instance' => $repeat_instance, 'field' => $field,
                'message' => 'the server could not write a temporary file',
            ]);
            return ['status' => 'error', 'message' => 'The server could not write the recording.'];
        }

        try {
            // Two calls, and both are required. storeFile() copies the bytes
            // into the edoc store and returns a doc id -- or 0 -- which gets the
            // file onto the server and nowhere near the record.
            // addFileToField() is what puts it on the record. The instance is
            // not optional: an instrument that repeats will otherwise file every
            // measurement against instance 1.
            //
            // Note the method names: storeFile() and addFileToField(). There is
            // no REDCap::saveFile(), however plausible it reads.
            //
            // Note the leading backslash too. REDCap is a global class and this
            // file is in a namespace, so an unqualified REDCap:: names a class
            // in THIS namespace -- which does not exist. PHP raises an Error,
            // not an Exception, and the framework absorbs it: the page finishes
            // normally with the fields saved and the recording never filed.
            $docId = \REDCap::storeFile($tmp, $project_id, $filename);
            if (!$docId) {
                throw new Exception('REDCap::storeFile did not store the file.');
            }

            $linked = \REDCap::addFileToField(
                $docId, $project_id, $record, $field, $event_id, $repeat_instance
            );
            if (!$linked) {
                throw new Exception(
                    'Stored as doc ' . $docId . ' but addFileToField did not attach it to "'
                    . $field . '". Check that the field exists on the instrument and is a '
                    . 'File Upload field.'
                );
            }
        } catch (Throwable $e) {
            $this->log('AOBP recording failed', [
                'record'   => $record,
                'instance' => $repeat_instance,
                'field'    => $field,
                'message'  => $e->getMessage(),
            ]);
            return ['status' => 'error', 'message' => $e->getMessage()];
        } finally {
            @unlink($tmp);
        }

        $this->log('AOBP recording stored', [
            'record'   => $record,
            'instance' => $repeat_instance,
            'field'    => $field,
            'doc_id'   => $docId,
            'bytes'    => strlen($xml),
        ]);

        return [
            'status'   => 'saved',
            'field'    => $field,
            'doc_id'   => (string) $docId,
            'filename' => $filename,
            'bytes'    => strlen($xml),
            'sha256'   => hash('sha256', $xml),
        ];
    }

    /** Somewhere to put the bytes for the length of one request. */
    private function tempDir(): string
    {
        return defined('APP_PATH_TEMP') && is_dir(APP_PATH_TEMP)
            ? rtrim(APP_PATH_TEMP, '/' . DIRECTORY_SEPARATOR)
            : sys_get_temp_dir();
    }

    private function recordingFilename($record, $repeat_instance, $mode): string
    {
        return $record . '_inst' . ($repeat_instance ?: 1) . '_' . $mode . '_aobp.xml';
    }

    /**
     * How far the device clock may be out before it is set from the browser.
     *
     * The device timestamp is written into the result XML, so a clock that is
     * wrong mislabels data permanently. Blank or nonsense falls back to five
     * minutes rather than to no checking at all.
     */

    private function clockToleranceMinutes(): float
    {
        $configured = trim((string) $this->getProjectSetting('aobp-clock-tolerance-minutes'));
        if ($configured === '' || !is_numeric($configured) || (float) $configured < 0) {
            return 5.0;
        }
        return (float) $configured;
    }

    private function aobpInstrument(): string
    {
        $configured = trim((string) $this->getProjectSetting('aobp-instrument'));
        return $configured !== '' ? $configured : self::DEFAULT_AOBP_INSTRUMENT;
    }

    private function infoInstrument(): string
    {
        $configured = trim((string) $this->getProjectSetting('aobp-info-instrument'));
        return $configured !== '' ? $configured : self::DEFAULT_INFO_INSTRUMENT;
    }

    /**
     * The values the page script needs.
     *
     * `sdkUrl` is passed explicitly because the script imports the SDK as an ES
     * module at run time. Resolving it here means the import works whatever
     * this installation does with static file URLs.
     */
    /**
     * What REDCap has stored for one field on this record, or null.
     *
     * Null rather than '' when it cannot be read: for
     * sys_standing_required, "not required" and "not known" are different
     * answers, and the page says so rather than quietly finishing the visit.
     */
    private function storedValue($project_id, $record, $event_id, $repeat_instance, $field)
    {
        if ((string) $record === '') {
            return null;
        }

        try {
            $data = \REDCap::getData([
                'project_id'    => $project_id,
                'records'       => [$record],
                'fields'        => [$field],
                'events'        => $event_id ? [$event_id] : null,
                'return_format' => 'array',
            ]);
        } catch (Throwable $e) {
            return null;
        }

        $row = $data[$record] ?? null;
        if (!is_array($row)) {
            return null;
        }

        // Repeating instruments nest under repeat_instances; a flat event does
        // not. Both shapes are read rather than assuming which project this is.
        $instance = $repeat_instance ?: 1;
        $value = $row['repeat_instances'][$event_id][$this->aobpInstrument()][$instance][$field]
              ?? $row[$event_id][$field]
              ?? null;

        return ($value === null || $value === '') ? null : (string) $value;
    }

    private function storedStandingRequired($project_id, $record, $event_id, $repeat_instance)
    {
        return $this->storedValue(
            $project_id, $record, $event_id, $repeat_instance, 'sys_standing_required'
        );
    }

    /** The version in this module's own config.json, or 'unknown'. */
    private function moduleVersion(): string
    {
        $path = __DIR__ . '/config.json';
        if (!is_readable($path)) {
            return 'unknown';
        }
        $config = json_decode((string) file_get_contents($path), true);
        return is_array($config) && isset($config['version'])
            ? (string) $config['version']
            : 'unknown';
    }

    private function emitAobpConfig($project_id, $record, $event_id, $repeat_instance): void
    {
        $config = [
            'record'          => (string) $record,
            'event_id'        => (string) $event_id,
            'repeat_instance' => (string) $repeat_instance,
            'pid'             => (string) $project_id,
            'sdkUrl'          => $this->getUrl('sdk/index.js'),
            'saveXmlAsFile'   => (bool) $this->getProjectSetting('aobp-save-xml-file'),
            'clockToleranceMinutes' => $this->clockToleranceMinutes(),
            'trace'           => (bool) $this->getProjectSetting('aobp-trace'),
            'simulator'       => (bool) $this->getProjectSetting('aobp-simulator'),

            // So a console says which build answered. REDCap takes the version
            // from the directory name and shows it in the module list, but a
            // screenshot of a survey page shows neither.
            'moduleVersion'   => $this->moduleVersion(),

            // Read here because the page cannot read it for itself.
            //
            // sys_standing_required is a calc field with @HIDDEN, and REDCap
            // renders neither on a survey page — there is no input with that
            // name in the DOM, so the module found nothing, read it as empty,
            // and closed the visit after the seated measurement. A participant
            // who needed standing would have gone home without it.
            //
            // This is REDCap's own stored value for this record, event and
            // instance. It is what the calc last computed, so it is right
            // except where dizz or faint are answered on this very page and
            // not yet saved; the page prefers a live field where the
            // instrument provides one.
            'standingRequired' => $this->storedStandingRequired(
                $project_id, $record, $event_id, $repeat_instance
            ),
            // Default OFF. The TM2917 retries a determination it could not
            // measure and reports the attempt it discarded even when a later
            // one succeeded, so this fires over good readings with nothing for
            // the operator to do. A warning nobody can act on teaches people to
            // ignore the panel, and the panel is the only thing watching while
            // nobody is in the room. Recorded either way; this is display only.
            'detailedWarnings' => (bool) $this->getProjectSetting('aobp-show-recovered-warnings'),
        ];

        // json_encode with the HEX_* flags escapes everything that could close
        // the script element, so no value reaching the page can end it early.
        $json = json_encode(
            $config,
            JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
        );

        echo '<script>window.AOBP_CONFIG = ' . $json . ';</script>' . "\n";
    }

    private function emitScript(string $path): void
    {
        echo '<script src="' . htmlspecialchars($this->getUrl($path), ENT_QUOTES) . '"></script>' . "\n";
    }
}
