import { bridge } from '../bridge';
import type { PtyLaunchInfo } from '../bridge';
import { buildCdCommand } from './path';
import {
  detectPrompt,
  detectShellType,
  extractOsc7Cwds,
  extractPromptInfo,
  splitOnFirstOsc7,
} from './parser';
import type {
  TerminalCapabilities,
  TerminalSessionEvent,
  TerminalSessionStatus,
} from './types';

type SessionListener = (event: TerminalSessionEvent) => void;

export class TerminalSession {
  private static readonly replayLimit = 64 * 1024;
  private static readonly syncSuppressionTimeoutMs = 5000;
  private readonly listeners = new Set<SessionListener>();
  private readonly decoder = new TextDecoder();
  private readonly initialCwd: string;
  private ptyId: number | null = null;
  private currentCwd: string;
  private status: TerminalSessionStatus = 'idle';
  private capabilities: TerminalCapabilities;
  private launchInfo: PtyLaunchInfo | null = null;
  private replayData = '';
  private inputBuffer = '';
  private activeCommand: string | null = null;
  private cleanupData: (() => void) | null = null;
  private cleanupExit: (() => void) | null = null;
  private suppressSyncOutput = false;
  private suppressedOutput = '';
  private suppressTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSyncEchoCleanup = false;
  private readonly profileId?: string;

  constructor(initialCwd: string, profileId?: string) {
    this.initialCwd = initialCwd;
    this.profileId = profileId;
    this.currentCwd = initialCwd;
    this.capabilities = {
      shellType: 'unknown',
      cwd: initialCwd,
      profileId: profileId ?? null,
      hasOsc7Cwd: false,
      promptReady: false,
      commandRunning: false,
      lastCommand: null,
    };
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    if (this.launchInfo) {
      listener({ type: 'launch', launch: this.launchInfo });
    }
    listener({ type: 'status', status: this.status });
    listener({ type: 'capabilities', capabilities: this.capabilities });
    if (this.replayData) {
      listener({ type: 'data', data: this.replayData });
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCapabilities(): TerminalCapabilities {
    return this.capabilities;
  }

  async start(): Promise<void> {
    if (this.ptyId !== null || this.status === 'starting') return;

    this.setStatus('starting');
    try {
      const launch = await bridge.pty.spawn(this.initialCwd, this.profileId);
      this.acceptLaunch(launch);

      this.cleanupData = bridge.pty.onData((ptyId, data) => {
        if (ptyId !== this.ptyId) return;
        this.handleData(typeof data === 'string' ? data : this.decoder.decode(data, { stream: true }));
      });

      this.cleanupExit = bridge.pty.onExit((ptyId) => {
        if (ptyId !== this.ptyId) return;
        if (this.activeCommand) {
          this.emit({ type: 'command-finish', command: this.activeCommand });
        }
        this.activeCommand = null;
        this.capabilities = {
          ...this.capabilities,
          commandRunning: false,
          promptReady: false,
        };
        this.emitCapabilities();
        this.ptyId = null;
        this.setStatus('exited');
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus('error', message);
      throw error;
    }
  }

  async write(data: string): Promise<void> {
    if (this.ptyId === null) return;
    this.consumeUserInput(data);
    await bridge.pty.write(this.ptyId, data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.ptyId === null) return;
    await bridge.pty.resize(this.ptyId, Math.max(2, cols), Math.max(1, rows));
  }

  async syncToCwd(nextCwd: string): Promise<void> {
    if (this.ptyId === null || nextCwd === this.currentCwd) return;
    this.currentCwd = nextCwd;
    this.capabilities = {
      ...this.capabilities,
      cwd: nextCwd,
    };
    this.emit({ type: 'cwd', cwd: nextCwd });
    this.emitCapabilities();
    this.beginSyncSuppression();
    await bridge.pty.write(this.ptyId, buildCdCommand(nextCwd, this.capabilities.shellType));
  }

  async refreshPrompt(): Promise<void> {
    if (this.ptyId === null) return;
    if (this.capabilities.commandRunning) return;
    await bridge.pty.write(this.ptyId, '\r');
  }

  async dispose(): Promise<void> {
    this.cleanupData?.();
    this.cleanupData = null;
    this.cleanupExit?.();
    this.cleanupExit = null;
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = null;
    }

    if (this.ptyId !== null) {
      const id = this.ptyId;
      this.ptyId = null;
      await bridge.pty.close(id);
    }
  }

  private acceptLaunch(launch: PtyLaunchInfo): void {
    this.launchInfo = launch;
    this.ptyId = launch.ptyId;
    this.currentCwd = launch.cwd;
    this.capabilities = {
      ...this.capabilities,
      cwd: launch.cwd,
      profileId: launch.profileId,
      shellType: detectShellType(launch.shell),
    };

    this.emit({ type: 'launch', launch });
    this.emitCapabilities();
    this.setStatus('running');
  }

  private handleData(data: string): void {
    if (this.suppressSyncOutput) {
      this.suppressedOutput += data;
      const syncOscResult = splitOnFirstOsc7(this.suppressedOutput);
      if (syncOscResult) {
        this.endSyncSuppression();
        this.pendingSyncEchoCleanup = false;
        this.applyCwdUpdate(syncOscResult.cwd);
        if (syncOscResult.after) {
          this.processVisibleData(`\r\x1b[2K${syncOscResult.after}`);
        }
        return;
      }

      const promptInfo = extractPromptInfo(this.suppressedOutput, this.capabilities.shellType);
      const fallbackPrompt = this.extractSuppressedPrompt(this.suppressedOutput);
      if (!promptInfo && !fallbackPrompt) return;

      this.endSyncSuppression();
      this.pendingSyncEchoCleanup = false;
      const resolvedPrompt = promptInfo ?? fallbackPrompt;
      if (resolvedPrompt?.cwd) {
        this.applyCwdUpdate(resolvedPrompt.cwd);
      }
      this.processVisibleData(`\r\x1b[2K${resolvedPrompt?.prompt ?? ''}`);
      return;
    }

    this.processVisibleData(data);
  }

  private processVisibleData(data: string): void {
    const visibleData = this.sanitizePendingSyncEcho(data);
    if (!visibleData) return;

    this.replayData = (this.replayData + visibleData).slice(-TerminalSession.replayLimit);
    this.emit({ type: 'data', data: visibleData });

    const cwdUpdates = extractOsc7Cwds(visibleData);
    const latestCwd = cwdUpdates[cwdUpdates.length - 1];
    if (latestCwd) {
      this.applyCwdUpdate(latestCwd);
    } else {
      const promptInfo = extractPromptInfo(visibleData, this.capabilities.shellType);
      if (promptInfo?.cwd) {
        this.applyCwdUpdate(promptInfo.cwd);
      }
    }

    if (detectPrompt(visibleData, this.capabilities.shellType)) {
      this.pendingSyncEchoCleanup = false;
      if (this.activeCommand) {
        this.emit({ type: 'command-finish', command: this.activeCommand });
      }
      this.activeCommand = null;
      this.capabilities = {
        ...this.capabilities,
        commandRunning: false,
        promptReady: true,
      };
      this.emitCapabilities();
    }
  }

  private applyCwdUpdate(cwd: string): void {
    if (cwd === this.currentCwd) return;
    this.currentCwd = cwd;
    this.capabilities = {
      ...this.capabilities,
      cwd,
      hasOsc7Cwd: true,
    };
    this.emit({ type: 'cwd', cwd });
    this.emitCapabilities();
  }

  private consumeUserInput(data: string): void {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const command = this.inputBuffer.trim();
        this.inputBuffer = '';
        if (!command) continue;
        this.activeCommand = command;
        this.capabilities = {
          ...this.capabilities,
          commandRunning: true,
          promptReady: false,
          lastCommand: command,
        };
        this.emit({ type: 'command-start', command });
        this.emitCapabilities();
      } else if (ch === '\u007f' || ch === '\b') {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
      } else if (ch >= ' ' || ch === '\t') {
        this.inputBuffer += ch;
      }
    }
  }

  private emit(event: TerminalSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private emitCapabilities(): void {
    this.emit({ type: 'capabilities', capabilities: this.capabilities });
  }

  private setStatus(status: TerminalSessionStatus, error?: string): void {
    this.status = status;
    this.emit({ type: 'status', status, error });
  }

  private beginSyncSuppression(): void {
    this.suppressSyncOutput = true;
    this.suppressedOutput = '';
    this.pendingSyncEchoCleanup = true;
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
    }
    this.suppressTimer = setTimeout(() => {
      const buffered = this.suppressedOutput;
      this.endSyncSuppression();
      if (buffered) {
        const promptInfo = extractPromptInfo(buffered, this.capabilities.shellType);
        const fallbackPrompt = this.extractSuppressedPrompt(buffered);
        if (promptInfo?.cwd) {
          this.pendingSyncEchoCleanup = false;
          this.applyCwdUpdate(promptInfo.cwd);
          this.processVisibleData(`\r\x1b[2K${promptInfo.prompt}`);
        } else if (fallbackPrompt) {
          this.pendingSyncEchoCleanup = false;
          if (fallbackPrompt.cwd) {
            this.applyCwdUpdate(fallbackPrompt.cwd);
          }
          this.processVisibleData(`\r\x1b[2K${fallbackPrompt.prompt}`);
        } else if (!this.looksLikeSuppressedSyncEcho(buffered)) {
          this.pendingSyncEchoCleanup = false;
          this.processVisibleData(buffered);
        } else {
          this.pendingSyncEchoCleanup = false;
        }
      }
    }, TerminalSession.syncSuppressionTimeoutMs);
  }

  private endSyncSuppression(): void {
    this.suppressSyncOutput = false;
    this.suppressedOutput = '';
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = null;
    }
  }

  private looksLikeSuppressedSyncEcho(data: string): boolean {
    const normalized = data.replace(/\r/g, '').trim();
    if (!normalized) return true;

    if (this.capabilities.shellType === 'powershell') {
      return normalized.includes('Set-Location -LiteralPath') || normalized.startsWith('cd "') || normalized.includes('\ncd "');
    }

    if (this.capabilities.shellType === 'cmd') {
      return normalized.includes('cd /d "');
    }

    return normalized.startsWith('cd ') || normalized.includes('Set-Location -LiteralPath');
  }

  private extractSuppressedPrompt(data: string): { prompt: string; cwd: string | null } | null {
    if (this.capabilities.shellType === 'powershell') {
      const matches = [...data.matchAll(/PS [^\r\n>]+>\s*/g)];
      const lastMatch = matches.length > 0 ? matches[matches.length - 1] : undefined;
      const last = lastMatch?.[0]?.trimEnd();
      if (!last) return null;
      const cwdMatch = last.match(/^PS (.+)>\s*$/);
      return {
        prompt: last,
        cwd: cwdMatch?.[1] ?? null,
      };
    }

    if (this.capabilities.shellType === 'cmd') {
      const matches = [...data.matchAll(/[A-Za-z]:\\[^\r\n>]*>\s*/g)];
      const lastMatch = matches.length > 0 ? matches[matches.length - 1] : undefined;
      const last = lastMatch?.[0]?.trimEnd();
      if (!last) return null;
      const cwdMatch = last.match(/^([A-Za-z]:\\.*)>\s*$/);
      return {
        prompt: last,
        cwd: cwdMatch?.[1] ?? null,
      };
    }

    return null;
  }

  private sanitizePendingSyncEcho(data: string): string {
    if (!this.pendingSyncEchoCleanup) return data;

    if (this.capabilities.shellType === 'powershell') {
      const match = data.match(/(?:PS [^\r\n>]+>\s*)?cd(?:\s+|\r?\n)+"([^"]+)"(?:\r?\n)+(PS [^\r\n>]+>\s*)/s);
      if (match?.[2]) {
        this.pendingSyncEchoCleanup = false;
        return `\r\x1b[2K${match[2].trimEnd()}`;
      }
      if (/\bcd(?:\s+|\r?\n)+"[^"]*"?/s.test(data)) {
        return '';
      }
    }

    if (this.capabilities.shellType === 'cmd') {
      const match = data.match(/(?:[A-Za-z]:\\[^\r\n>]*>\s*)?cd \/d "([^"]+)"(?:\r?\n)+([A-Za-z]:\\[^\r\n>]*>\s*)/s);
      if (match?.[2]) {
        this.pendingSyncEchoCleanup = false;
        return `\r\x1b[2K${match[2].trimEnd()}`;
      }
      if (/\bcd \/d ".*"?/s.test(data)) {
        return '';
      }
    }

    if (detectPrompt(data, this.capabilities.shellType)) {
      this.pendingSyncEchoCleanup = false;
    }

    return data;
  }
}
