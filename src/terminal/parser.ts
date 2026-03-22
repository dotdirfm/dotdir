import type { TerminalShellType } from './types';
import { normalizeTerminalPath } from './path';

const OSC_7_RE = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function detectShellType(shellPath: string): TerminalShellType {
  const lower = shellPath.toLowerCase();
  if (lower.endsWith('bash')) return 'bash';
  if (lower.endsWith('zsh')) return 'zsh';
  if (lower.endsWith('cmd.exe')) return 'cmd';
  if (lower.endsWith('powershell.exe') || lower.endsWith('pwsh.exe')) return 'powershell';
  if (lower.endsWith('/sh') || lower.endsWith('\\sh.exe')) return 'sh';
  return 'unknown';
}

export function extractOsc7Cwds(data: string): string[] {
  const paths: string[] = [];
  for (const match of data.matchAll(OSC_7_RE)) {
    const raw = match[1];
    const pathMatch = raw.match(/^file:\/\/[^/]*(\/.*)/);
    if (!pathMatch) continue;
    paths.push(normalizeTerminalPath(decodeURIComponent(pathMatch[1])));
  }
  return paths;
}

export function splitOnFirstOsc7(data: string): { cwd: string; after: string } | null {
  const match = OSC_7_RE.exec(data);
  OSC_7_RE.lastIndex = 0;
  if (!match) return null;

  const raw = match[1];
  const pathMatch = raw.match(/^file:\/\/[^/]*(\/.*)/);
  if (!pathMatch) return null;

  return {
    cwd: normalizeTerminalPath(decodeURIComponent(pathMatch[1])),
    after: data.slice(match.index + match[0].length),
  };
}

function stripControlSequences(data: string): string {
  return data
    .replace(OSC_7_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(/\r/g, '')
    .replace(/\x08/g, '');
}

function splitVisibleLines(data: string): string[] {
  return stripControlSequences(data)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function isCmdPrompt(line: string): boolean {
  return /^[A-Za-z]:\\.*>$/.test(line.trim());
}

function isPowerShellPrompt(line: string): boolean {
  return /^PS .+>\s*$/.test(line.trim());
}

function isPosixPrompt(line: string): boolean {
  return /[$#%]\s*$/.test(line.trim());
}

export function detectPrompt(data: string, shellType: TerminalShellType): boolean {
  const lines = splitVisibleLines(data);
  if (lines.length === 0) return false;
  const lastLine = lines[lines.length - 1];

  switch (shellType) {
    case 'cmd':
      return isCmdPrompt(lastLine);
    case 'powershell':
      return isPowerShellPrompt(lastLine);
    case 'bash':
    case 'zsh':
    case 'sh':
      return isPosixPrompt(lastLine);
    default:
      return isCmdPrompt(lastLine) || isPowerShellPrompt(lastLine) || isPosixPrompt(lastLine);
  }
}

export interface PromptInfo {
  prompt: string;
  cwd: string | null;
}

export function extractPromptInfo(data: string, shellType: TerminalShellType): PromptInfo | null {
  const lines = splitVisibleLines(data);
  if (lines.length === 0) return null;

  const prompt = lines[lines.length - 1];
  if (shellType === 'cmd') {
    const match = prompt.match(/^([A-Za-z]:\\.*)>$/);
    if (!match) return null;
    return {
      prompt,
      cwd: normalizeTerminalPath(match[1]),
    };
  }

  if (shellType === 'powershell') {
    const match = prompt.match(/^PS (.+)>\s*$/);
    if (!match) return null;
    return {
      prompt,
      cwd: normalizeTerminalPath(match[1]),
    };
  }

  if (detectPrompt(data, shellType)) {
    return { prompt, cwd: null };
  }

  return null;
}
