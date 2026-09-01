<?php

namespace AobpIntegration;

use ExternalModules\AbstractExternalModule;
use Exception;

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

        $mode = $payload['mode'] ?? '';
        $xml  = $payload['xml'] ?? '';

        if ($mode !== 'seated' && $mode !== 'standing') {
            return ['status' => 'error', 'message' => 'Unknown measurement mode.'];
        }
        if ($xml === '' || strpos($xml, '<BPplus') === false) {
            return ['status' => 'error', 'message' => 'That does not look like a BP+ measurement.'];
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

        // Held, not filed. Filing it now creates an edoc that the next page
        // submit destroys: REDCap saves every field on the page, the file input
        // is empty because nobody chose a file, and clearing a file field sets
        // delete_date on the edoc metadata. Re-attaching that doc id afterwards
        // put the link back in the exports and gave a download of "Either this
        // file does not exist OR you do not have permission to download it" —
        // a link to a file REDCap considers deleted.
        //
        // So the bytes wait here, and redcap_save_record files them once the
        // save that would have destroyed them is over. One edoc per recording,
        // and never a tombstoned one.
        $stash = $this->stashPath($project_id, $record, $event_id, $repeat_instance, $field);

        if (file_put_contents($stash, $xml) === false) {
            $this->log('AOBP recording could not be held', [
                'record' => $record, 'instance' => $repeat_instance, 'field' => $field,
            ]);
            return ['status' => 'error', 'message' => 'The server could not hold the recording.'];
        }

        $filename = $this->recordingFilename($record, $repeat_instance, $mode);

        $this->log('AOBP recording held for saving', [
            'record'   => $record,
            'instance' => $repeat_instance,
            'field'    => $field,
            'bytes'    => strlen($xml),
        ]);

        return [
            'status'   => 'success',
            'field'    => $field,
            'filename' => $filename,
        ];
    }

    /** Where one recording waits between the measurement and the page save. */
    private function stashPath($project_id, $record, $event_id, $repeat_instance, $field): string
    {
        $dir = defined('APP_PATH_TEMP') && is_dir(APP_PATH_TEMP)
            ? rtrim(APP_PATH_TEMP, '/' . DIRECTORY_SEPARATOR)
            : sys_get_temp_dir();

        // Hashed, because a record id is whatever the project allows and this
        // becomes a path. Deterministic, because the save has to find it again.
        $key = md5(implode('|', [$project_id, $record, $event_id, $repeat_instance ?: 1, $field]));

        return $dir . DIRECTORY_SEPARATOR . 'aobp_pending_' . $key . '.xml';
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

    /**
     * File the recordings the page left waiting, now the save is over.
     *
     * This runs after the submit that would have destroyed them. The file
     * fields are on the instrument being filled in, REDCap saves every field on
     * the page, and the file input is empty because nobody chose a file — so an
     * edoc attached before the submit gets cleared, and clearing a file field
     * sets delete_date on its metadata. The link can be put back; the file
     * cannot, because REDCap will not serve a row it considers deleted. That is
     * the "Either this file does not exist OR you do not have permission to
     * download it" a working link gave.
     *
     * So nothing is filed until here: one edoc per recording, created after the
     * only thing that would have killed it.
     */
    public function redcap_save_record(
        $project_id,
        $record,
        $instrument,
        $event_id,
        $group_id,
        $survey_hash,
        $response_id,
        $repeat_instance
    ) {
        if ($instrument !== $this->aobpInstrument()) {
            return;
        }

        foreach (['seated' => 'seated_raw_xml', 'standing' => 'standing_raw_xml'] as $mode => $field) {
            $this->fileHeldRecording(
                $project_id, $record, $event_id, $repeat_instance, $mode, $field
            );
        }
    }

    private function fileHeldRecording(
        $project_id, $record, $event_id, $repeat_instance, $mode, $field
    ): void {
        $stash = $this->stashPath($project_id, $record, $event_id, $repeat_instance, $field);
        if (!is_file($stash)) {
            return;                       // nothing waiting for this position
        }

        $filename = $this->recordingFilename($record, $repeat_instance, $mode);

        try {
            $docId = \REDCap::storeFile($stash, $project_id, $filename);
            if (!$docId) {
                throw new Exception('REDCap::storeFile did not store the file.');
            }

            $linked = \REDCap::addFileToField(
                $docId, $project_id, $record, $field, $event_id, $repeat_instance
            );
            if (!$linked) {
                throw new Exception(
                    'Stored as doc ' . $docId . ' but addFileToField did not attach it.'
                );
            }

            $this->log('AOBP recording stored', [
                'record'   => $record,
                'instance' => $repeat_instance,
                'field'    => $field,
                'doc_id'   => $docId,
                'bytes'    => (string) filesize($stash),
            ]);
        } catch (Throwable $e) {
            // Left in place deliberately: the next save of this instance tries
            // again, and a recording is not thrown away because one attempt
            // failed.
            $this->log('AOBP recording failed', [
                'record'   => $record,
                'instance' => $repeat_instance,
                'field'    => $field,
                'message'  => $e->getMessage(),
            ]);
            return;
        }

        unlink($stash);
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
