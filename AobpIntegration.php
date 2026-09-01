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

        $tmpFile = tempnam(sys_get_temp_dir(), 'aobp_');
        if ($tmpFile === false) {
            return ['status' => 'error', 'message' => 'Could not create a temporary file.'];
        }

        try {
            if (file_put_contents($tmpFile, $xml) === false) {
                throw new Exception('Could not write the temporary file.');
            }

            $filename = $record . '_inst' . $repeat_instance . '_' . $mode . '_aobp.xml';

            // Two steps, and both are required.
            //
            // storeFile() copies the file into REDCap's edoc store and registers
            // it, returning a doc id — or 0. That gets it onto the server and
            // nowhere near the participant: nothing yet says which record, event,
            // instance or field it belongs to.
            //
            // addFileToField() is what puts it on the record, and is the step
            // that makes it visible on the form and downloadable afterwards.
            // The instance matters here: aobp_visit repeats, and a file filed
            // without one lands on the first instance whatever visit it came
            // from.
            $docId = \REDCap::storeFile($tmpFile, $project_id, $filename);
            if (!$docId) {
                throw new Exception('REDCap::storeFile did not store the file.');
            }

            $linked = \REDCap::addFileToField(
                $docId,
                $project_id,
                $record,
                $field,
                $event_id,
                $repeat_instance
            );

            if (!$linked) {
                throw new Exception(
                    'The file was stored as doc ' . $docId .
                    ' but REDCap::addFileToField did not attach it to ' . $field . '.'
                );
            }

            $this->log('AOBP recording stored', [
                'record'   => $record,
                'instance' => $repeat_instance,
                'field'    => $field,
                'doc_id'   => $docId,
                'bytes'    => strlen($xml),
            ]);

            return [
                'status'   => 'success',
                'field'    => $field,
                'filename' => $filename,
                'doc_id'   => $docId,
            ];
        } catch (Exception $e) {
            $this->log('AOBP recording failed', [
                'record'   => $record,
                'instance' => $repeat_instance,
                'field'    => $field,
                'message'  => $e->getMessage(),
            ]);
            return ['status' => 'error', 'message' => $e->getMessage()];
        } finally {
            if (is_file($tmpFile)) {
                unlink($tmpFile);
            }
        }
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
