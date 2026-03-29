import { CwdEscapeMode, TerminalProfile } from "@/shared/api/bridge";
import { normalizePath } from "../path";

export function normalizeTerminalPath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/");
  const match = normalized.match(/^\/([A-Za-z]:(?:\/.*)?)/);
  return normalizePath(match ? match[1] : normalized);
}

function escapeCwdForMode(cwd: string, mode: CwdEscapeMode): string {
  switch (mode) {
    case "posix":
      return "'" + cwd.replace(/'/g, "'\\''") + "'";
    case "powershell":
      return "'" + cwd.replace(/'/g, "''") + "'";
    case "cmd":
      return '"' + cwd.replace(/"/g, '""') + '"';
  }
}

/**
 * Hidden `cd` sent before running a command from the command line or panel sync.
 * Template comes from shell-integration contributions (`{{cwd}}` = escaped path).
 */
export function formatHiddenCd(absoluteCwd: string, profile: TerminalProfile): string {
  const normalized = normalizeTerminalPath(absoluteCwd);
  const escaped = escapeCwdForMode(normalized, profile.cwdEscape);
  const body = profile.hiddenCdTemplate.replace(/\{\{cwd\}\}/g, escaped);
  const eol = profile.lineEnding ?? "\n";
  return body + eol;
}
