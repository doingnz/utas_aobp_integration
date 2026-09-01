/**
 * Build the module folder REDCap installs, with a version that cannot drift.
 *
 *   node tools/package.mjs
 *
 * REDCap reads a module's version from its DIRECTORY NAME, so two builds in a
 * folder called `_v1.0.0` are the same version as far as REDCap, its module
 * list and its logs are concerned. A dozen changes shipped that way, and the
 * only way to tell which one a server was running was to read the code.
 *
 * The patch number is now the commit count: `1.0.59` is the 59th commit, and
 * `git rev-list --count` of the installed number finds exactly the code that
 * was packaged. It only ever goes up, and it cannot be forgotten, because
 * nobody types it.
 *
 * Stamped into the copy under dist/ and not into the repository's own
 * config.json, deliberately. Committing the stamp would raise the commit count
 * that produced it, so the file would always name the version before itself.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const git = (...args) => execFileSync('git', args, { cwd: root }).toString().trim();

const count = git('rev-list', '--count', 'HEAD');
const sha = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain') !== '';
const version = `1.0.${count}`;
const name = `utas_aobp_integration_v${version}`;

if (dirty) {
  console.error(
    'Uncommitted changes. The version names a commit, so packaging now would\n' +
    'produce a folder called ' + name + ' that does not match ' + sha + '.\n' +
    'Commit first, then package.'
  );
  process.exit(1);
}

// What REDCap serves. Not test/, not data_dictionary/, not dist/ itself.
const SHIPPED = ['AobpIntegration.php', 'config.json', 'README.md', 'js', 'sdk'];

const target = path.join(dist, name);
for (const old of fs.existsSync(dist) ? fs.readdirSync(dist) : []) {
  if (old.startsWith('utas_aobp_integration_v')) {
    fs.rmSync(path.join(dist, old), { recursive: true, force: true });
  }
}
fs.mkdirSync(target, { recursive: true });

for (const entry of SHIPPED) {
  fs.cpSync(path.join(root, entry), path.join(target, entry), { recursive: true });
}

// The stamp REDCap shows in its module list, and the one the page logs so a
// browser console says which build answered.
const configPath = path.join(target, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.version = version;
config.description += ` (build ${version}, commit ${sha})`;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

const zip = path.join(dist, `${name}.zip`);
fs.rmSync(zip, { force: true });
execFileSync('powershell.exe', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${target}' -DestinationPath '${zip}' -Force`,
]);

const files = execFileSync('powershell.exe', [
  '-NoProfile', '-Command',
  `(Get-ChildItem -Recurse -File '${target}').Count`,
]).toString().trim();

console.log(`packaged ${name}`);
console.log(`  commit  ${sha}`);
console.log(`  files   ${files}`);
console.log(`  zip     ${path.relative(root, zip)} ` +
            `(${Math.round(fs.statSync(zip).size / 1024)} kB)`);
