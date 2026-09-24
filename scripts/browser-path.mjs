import { existsSync } from 'node:fs';
import { join } from 'node:path';
export function browserPath() {
  const candidates = [process.env.CHROMIUM_PATH,
    join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')];
  return candidates.find(path => path && existsSync(path));
}
