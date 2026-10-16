import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

// Read-only conflict detection. Matching a profile NEVER grants authority to
// close/kill that process. Only the cooperative session protocol does that.
export const assertProfileAvailable = async profile => {
  if (process.platform !== 'win32') return; // native browser profile locks apply on Unix
  const { stdout } = await exec('powershell.exe', ['-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$ErrorActionPreference=\'Stop\'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'^(chrome|chromium|chrome-headless-shell|msedge|firefox)\\.exe$\' } | Select-Object -ExpandProperty CommandLine) | ConvertTo-Json -Compress'],
  { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const commands = stdout.trim() ? JSON.parse(stdout) : [];
  const expected = (await realpath(profile)).toLowerCase();
  for (const command of Array.isArray(commands) ? commands : [commands]) {
    if (!command) throw Error('Cannot inspect a browser process; refusing unsafe profile reuse.');
    const matches = command.matchAll(/(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+)|(?:--user-data-dir|-{1,2}profile)\s+"([^"]+)"|(?:--user-data-dir|-{1,2}profile)\s+([^\s"]+))/g);
    for (const match of matches) {
      const candidate = match.slice(1).find(Boolean);
      const canonical = await realpath(candidate).catch(() => path.resolve(candidate));
      if (canonical.toLowerCase() === expected) {
        throw Error('Browser profile is in use by an unowned browser. Close it manually or choose a separate BROWSER_DIR; nothing was killed.');
      }
    }
  }
};
