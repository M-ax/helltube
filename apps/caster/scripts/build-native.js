import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../native', import.meta.url));
mkdirSync(`${root}/bin`, {recursive: true});
if (process.platform === 'win32') {
    for (const args of [['-S', root, '-B', `${root}/build`, '-A', 'x64'], ['--build', `${root}/build`, '--config', 'Release']]) {
        const result = spawnSync('cmake', args, {stdio: 'inherit', windowsHide: true});
        if (result.error || result.status !== 0) {
            console.error('Install CMake and Visual Studio C++ build tools with a Windows 11 SDK.'); process.exit(1);
        }
    }
} else if (process.platform !== 'linux') {
    throw new Error('Helltube Caster currently supports Windows and Linux.');
}
