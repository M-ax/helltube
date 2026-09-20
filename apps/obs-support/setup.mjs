import {readFile, access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const source = fileURLToPath(new URL('../obs-studio/', import.meta.url));
const patch = fileURLToPath(new URL('./helltube.patch', import.meta.url));
const upstream = JSON.parse(await readFile(new URL('./upstream.json', import.meta.url), 'utf8'));
const exists = path => access(path).then(() => true, () => false);
function git(args, {check = true, quiet = false} = {}) {
    const result = spawnSync('git', args, {encoding: 'utf8', windowsHide: true,
        stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'});
    if (result.error) throw result.error;
    if (check && result.status !== 0) throw new Error(`git ${args[0]} failed (${result.status}).`);
    return result;
}

if (!await exists(source)) {
    git(['clone', '--no-checkout', '--filter=blob:none', upstream.repository, source]);
    git(['-C', source, 'checkout', '--detach', upstream.revision]);
}
const head = git(['-C', source, 'rev-parse', 'HEAD'], {quiet: true}).stdout.trim();
if (head !== upstream.revision) throw new Error(`Expected OBS ${upstream.revision}, found ${head}. Keep your changes and use a separate checkout.`);
git(['-C', source, 'submodule', 'update', '--init', '--recursive', '--depth', '1']);
if (git(['-C', source, 'apply', '--reverse', '--check', patch], {check: false, quiet: true}).status === 0) {
    console.log('Helltube support is already applied.');
} else {
    git(['-C', source, 'apply', '--check', patch]);
    git(['-C', source, 'apply', patch]);
    console.log('Applied Helltube support.');
}
console.log(`OBS source: ${source}`);
