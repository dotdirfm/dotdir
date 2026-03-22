import { bridge, type CwdEscapeMode, type TerminalProfile } from '../bridge';
import type { LoadedExtension } from '../extensions';

export interface ShellProfilesResult {
  profiles: TerminalProfile[];
  shellScripts: Record<string, { script: string; scriptArg: boolean }>;
}

function matchesPlatform(
  platforms: ('darwin' | 'linux' | 'unix' | 'windows')[] | undefined,
  platform: string,
): boolean {
  if (!platforms) return true;
  return platforms.some((p) => {
    if (p === platform) return true;
    if (p === 'darwin' && platform === 'macos') return true;
    if (p === 'unix' && (platform === 'macos' || platform === 'linux')) return true;
    return false;
  });
}

function substituteVars(path: string, env: Record<string, string>): string {
  return path.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => env[name] ?? '');
}

/** Fallback when a contribution omits fields (extensions should normally set all of these). */
function defaultIntegration(shell: string): {
  hiddenCdTemplate: string;
  cwdEscape: CwdEscapeMode;
  lineEnding: '\n' | '\r\n';
  spawnArgs: string[];
} {
  const s = shell.toLowerCase();
  if (s === 'cmd') {
    return {
      hiddenCdTemplate: '@cd /d {{cwd}}',
      cwdEscape: 'cmd',
      lineEnding: '\r\n',
      spawnArgs: [],
    };
  }
  if (s === 'powershell' || s === 'pwsh') {
    return {
      hiddenCdTemplate: 'Set-Location -LiteralPath {{cwd}}',
      cwdEscape: 'powershell',
      lineEnding: '\r\n',
      spawnArgs: [],
    };
  }
  return {
    hiddenCdTemplate: 'cd {{cwd}}',
    cwdEscape: 'posix',
    lineEnding: '\n',
    spawnArgs: [],
  };
}

function profileFromContribution(
  shellPath: string,
  label: string,
  si: {
    shell: string;
    label: string;
    script: string;
    hiddenCdTemplate?: string;
    cwdEscape?: CwdEscapeMode;
    lineEnding?: '\n' | '\r\n';
    spawnArgs?: string[];
  },
): TerminalProfile {
  const d = defaultIntegration(si.shell);
  return {
    id: shellPath,
    label,
    shell: shellPath,
    hiddenCdTemplate: si.hiddenCdTemplate ?? d.hiddenCdTemplate,
    cwdEscape: si.cwdEscape ?? d.cwdEscape,
    lineEnding: si.lineEnding ?? d.lineEnding,
    spawnArgs: si.spawnArgs ?? d.spawnArgs,
  };
}

/**
 * Resolve available shell profiles from extension contributions.
 *
 * Each unique shell path becomes a profile (id = shell path).
 */
export async function resolveShellProfiles(
  extensions: LoadedExtension[],
  env: Record<string, string>,
): Promise<ShellProfilesResult> {
  const platform = env['__platform__'] ?? '';
  const shellEnv = env['SHELL'] ?? '';

  const profiles: TerminalProfile[] = [];
  const shellScripts: Record<string, { script: string; scriptArg: boolean }> = {};
  const seenPaths = new Set<string>();

  const contributions: Array<{
    shell: string;
    label: string;
    script: string;
    executableCandidates: string[];
    platforms?: ('darwin' | 'linux' | 'unix' | 'windows')[];
    hiddenCdTemplate?: string;
    cwdEscape?: CwdEscapeMode;
    lineEnding?: '\n' | '\r\n';
    spawnArgs?: string[];
    scriptArg?: boolean;
  }> = [];

  for (const ext of extensions) {
    for (const si of ext.shellIntegrations ?? []) {
      if (!matchesPlatform(si.platforms, platform)) continue;
      contributions.push(si);
    }
  }

  if (shellEnv && platform !== 'windows') {
    const shellBasename = shellEnv.split('/').pop() ?? '';
    const matched = contributions.find((c) => c.shell === shellBasename);
    if (matched && !seenPaths.has(shellEnv)) {
      try {
        const exists = await bridge.fsa.exists(shellEnv);
        if (exists) {
          seenPaths.add(shellEnv);
          profiles.push(profileFromContribution(shellEnv, matched.label, matched));
          shellScripts[shellEnv] = { script: matched.script, scriptArg: matched.scriptArg ?? false };
        }
      } catch {
        // Ignore
      }
    }
  }

  for (const si of contributions) {
    for (const candidate of si.executableCandidates) {
      const resolved = substituteVars(candidate, env);
      if (!resolved || seenPaths.has(resolved)) continue;
      try {
        const exists = await bridge.fsa.exists(resolved);
        if (exists) {
          seenPaths.add(resolved);
          profiles.push(profileFromContribution(resolved, si.label, si));
          shellScripts[resolved] = { script: si.script, scriptArg: si.scriptArg ?? false };
          break;
        }
      } catch {
        // Ignore
      }
    }
  }

  return { profiles, shellScripts };
}
