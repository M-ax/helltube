import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import WebSocket from 'ws';
import { HelperError } from './core.mjs';

const exec = promisify(execFile);
const recoveryError = () => new HelperError('A previous helper background browser is still running and could not be closed. Restart Windows, then reopen the helper. Your saved profile and export were preserved.');

// Match the exact dedicated profile, including Windows' two argument quoting styles.
// Query the process's listening port: an older helper may have deleted DevToolsActivePort.
const inspectScript = String.raw`
$ErrorActionPreference = 'Stop'
$profilePattern = [regex]::Escape($env:HELLTUBE_BROWSER_PROFILE)
$argumentPattern = '(?i)(?:^|\s)(?:"--user-data-dir=' + $profilePattern + '"|--user-data-dir="' + $profilePattern + '"|--user-data-dir=' + $profilePattern + ')(?=\s|$)'
$browsers = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" | Where-Object {
    $_.CommandLine -match $argumentPattern -and $_.CommandLine -notmatch '(?:^|\s)"?--type='
})
$result = @(foreach ($browser in $browsers) {
    $parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $browser.ParentProcessId)
    $orphaned = !$parent -or $parent.CreationDate -gt $browser.CreationDate
    $background = $browser.CommandLine -match '(?:^|\s)--headless=new(?=\s|$)' -and
        $browser.CommandLine -match '(?:^|\s)--remote-debugging-address=127\.0\.0\.1(?=\s|$)' -and
        $browser.CommandLine -match '(?:^|\s)--remote-debugging-port=0(?=\s|$)'
    $ports = @()
    if ($background -and $orphaned) {
        $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {
            $_.OwningProcess -eq $browser.ProcessId -and $_.LocalAddress -eq '127.0.0.1'
        } | Select-Object -ExpandProperty LocalPort)
    }
    @{ pid = [int]$browser.ProcessId; background = [bool]$background; orphaned = [bool]$orphaned; ports = $ports }
})
ConvertTo-Json -InputObject $result -Compress
`;

async function powershell(script, profile) {
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 20000, env: { ...process.env, HELLTUBE_BROWSER_PROFILE: path.resolve(profile) },
  });
}

async function closeBackgroundBrowser(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw recoveryError();
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw recoveryError();
  const { webSocketDebuggerUrl } = await response.json();
  if (typeof webSocketDebuggerUrl !== 'string' || !new RegExp(`^ws://127\\.0\\.0\\.1:${port}/devtools/browser/[a-zA-Z0-9-]+$`).test(webSocketDebuggerUrl)) throw recoveryError();
  // Only request a normal shutdown. Do not attach to pages, read cookies or force-kill.
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: 3000 });
    let sent = false;
    const timer = setTimeout(() => { socket.terminate(); reject(recoveryError()); }, 5000);
    socket.once('error', () => { clearTimeout(timer); reject(recoveryError()); });
    socket.once('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }), error => {
        if (error) { clearTimeout(timer); socket.terminate(); reject(recoveryError()); }
        else sent = true;
      });
    });
    socket.once('close', () => { clearTimeout(timer); if (sent) resolve(); else reject(recoveryError()); });
  });
}

export async function prepareBrowserProfile(profile) {
  if (process.platform !== 'win32') return;
  let processes;
  try { processes = JSON.parse((await powershell(inspectScript, profile)).stdout); }
  catch { throw new HelperError('Cannot check whether the helper browser is already running. Close its windows and try again.'); }
  if (processes.some(process => !process.background)) {
    throw new HelperError('The helper sign-in browser is still open. Close all of its windows, then try again.');
  }
  if (processes.some(process => !process.orphaned)) {
    throw new HelperError('The helper background browser is already in use. Quit the previous helper and try again.');
  }
  for (const process of processes) {
    let closed = false;
    for (const port of process.ports) {
      try { await closeBackgroundBrowser(port); closed = true; break; } catch {}
    }
    if (!closed) throw recoveryError();
    try {
      if (!Number.isInteger(process.pid) || process.pid <= 0) throw recoveryError();
      await powershell(`$ErrorActionPreference = 'Stop'; $owned = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; if ($owned) { $owned | Wait-Process -Timeout 10 }; exit 0`, profile);
    } catch { throw recoveryError(); }
  }
}
