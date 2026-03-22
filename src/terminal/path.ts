import { normalizePath } from '../path';
import type { TerminalShellType } from './types';

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function shellQuote(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

export function normalizeTerminalPath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/');
  const match = normalized.match(/^\/([A-Za-z]:(?:\/.*)?)/);
  return normalizePath(match ? match[1] : normalized);
}

export function buildCdCommand(path: string, shellType: TerminalShellType): string {
  if (shellType === 'powershell') {
    const psPath = path.replace(/\//g, '\\').replace(/`/g, '``').replace(/"/g, '`"');
    return `cd "${psPath}"\r`;
  }

  if (isWindowsPath(path) || shellType === 'cmd') {
    const cmdPath = path.replace(/\//g, '\\').replace(/"/g, '""');
    return `@cd /d "${cmdPath}"\r`;
  }
  return ` cd ${shellQuote(path)}\n`;
}

