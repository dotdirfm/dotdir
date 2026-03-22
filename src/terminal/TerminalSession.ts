import { bridge } from '../bridge';
import type { PtyLaunchInfo } from '../bridge';
import { focusContext } from '../focusContext';
import { buildCdCommand, normalizeTerminalPath } from './path';
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
  private suppressNextCommandFinish = false;
  private cleanupData: (() => void) | null = null;
  private cleanupExit: (() => void) | null = null;
  private suppressSyncOutput = false;
  private suppressedOutput = '';
  private suppressTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCwdSync: string | null = null;
  private pendingVisibleSyncEcho = false;
  private visibleSyncEchoBuffer = '';
  private expectedVisibleSyncCwd: string | null = null;
  private recentAutoSyncCommand: string | null = null;
  private recentAutoSyncPrompt: string | null = null;
  private recentAutoSyncExpiresAt = 0;
  private readonly profileId?: string;

  constructor(initialCwd: string, profileId?: string) {
    const normalizedInitialCwd = normalizeTerminalPath(initialCwd);
    this.initialCwd = normalizedInitialCwd;
    this.profileId = profileId;
    this.currentCwd = normalizedInitialCwd;
    this.capabilities = {
      shellType: 'unknown',
      cwd: normalizedInitialCwd,
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

  getReplayData(): string {
    return this.replayData;
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

  /** Write data to the PTY without emitting command-finish when the shell returns to a prompt. */
  async writeHidden(data: string): Promise<void> {
    if (this.ptyId === null) return;
    this.suppressNextCommandFinish = true;
    this.consumeUserInput(data);
    await bridge.pty.write(this.ptyId, data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.ptyId === null) return;
    await bridge.pty.resize(this.ptyId, Math.max(2, cols), Math.max(1, rows));
  }

  async syncToCwd(nextCwd: string): Promise<void> {
    const normalizedNextCwd = normalizeTerminalPath(nextCwd);
    if (this.ptyId === null || normalizedNextCwd === this.currentCwd) return;
    if (this.capabilities.commandRunning || (this.inputBuffer.length > 0 && focusContext.is('terminal'))) {
      this.pendingCwdSync = normalizedNextCwd;
      return;
    }
    await this.performCwdSync(normalizedNextCwd);
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
    this.pendingCwdSync = null;
    this.pendingVisibleSyncEcho = false;
    this.visibleSyncEchoBuffer = '';
    this.expectedVisibleSyncCwd = null;
    this.recentAutoSyncCommand = null;
    this.recentAutoSyncPrompt = null;
    this.recentAutoSyncExpiresAt = 0;

    if (this.ptyId !== null) {
      const id = this.ptyId;
      this.ptyId = null;
      await bridge.pty.close(id);
    }
  }

  private acceptLaunch(launch: PtyLaunchInfo): void {
    const normalizedCwd = normalizeTerminalPath(launch.cwd);
    this.launchInfo = launch;
    this.ptyId = launch.ptyId;
    this.currentCwd = normalizedCwd;
    this.capabilities = {
      ...this.capabilities,
      cwd: normalizedCwd,
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
        const cwd = this.expectedVisibleSyncCwd ?? syncOscResult.cwd;
        this.applyCwdUpdate(cwd, false);
        this.processVisibleData(this.renderSuppressedPrompt(this.buildPromptForCwd(cwd)));
        this.emit({ type: 'sync-complete', cwd: this.currentCwd });
        return;
      }

      const promptInfo = extractPromptInfo(this.suppressedOutput, this.capabilities.shellType);
      const fallbackPrompt = this.extractSuppressedPrompt(this.suppressedOutput);
      if (!promptInfo && !fallbackPrompt) return;

      this.endSyncSuppression();
      const resolvedPrompt = promptInfo ?? fallbackPrompt;
      const cwd = this.expectedVisibleSyncCwd ?? resolvedPrompt?.cwd ?? this.currentCwd;
      this.applyCwdUpdate(cwd, false);
      this.processVisibleData(this.renderSuppressedPrompt(this.buildPromptForCwd(cwd)));
      this.emit({ type: 'sync-complete', cwd: this.currentCwd });
      return;
    }

    this.processVisibleData(data);
  }

  private processVisibleData(data: string): void {
    const visibleData = this.sanitizeRecentAutoSyncEcho(this.consumePendingVisibleSyncEcho(data));
    if (!visibleData) return;

    this.replayData = this.sanitizeReplayData((this.replayData + visibleData).slice(-TerminalSession.replayLimit));
    this.emit({ type: 'data', data: visibleData });

    const cwdUpdates = extractOsc7Cwds(visibleData);
    const latestCwd = cwdUpdates[cwdUpdates.length - 1];
    if (latestCwd) {
      this.applyCwdUpdate(latestCwd, this.capabilities.commandRunning);
    } else {
      const promptInfo = extractPromptInfo(visibleData, this.capabilities.shellType);
      if (promptInfo?.cwd) {
        this.applyCwdUpdate(promptInfo.cwd, this.capabilities.commandRunning);
      }
    }

    if (detectPrompt(visibleData, this.capabilities.shellType)) {
      this.finishCommand();
    }
  }

  private finishCommand(): void {
    const suppress = this.suppressNextCommandFinish;
    this.suppressNextCommandFinish = false;
    if (!suppress && this.activeCommand) {
      this.emit({ type: 'command-finish', command: this.activeCommand });
    }
    this.activeCommand = null;
    this.capabilities = {
      ...this.capabilities,
      commandRunning: false,
      promptReady: true,
    };
    this.emitCapabilities();
    this.flushPendingCwdSync();
  }

  private applyCwdUpdate(cwd: string, userInitiated: boolean): void {
    const normalizedCwd = normalizeTerminalPath(cwd);
    if (normalizedCwd === this.currentCwd) return;
    this.currentCwd = normalizedCwd;
    this.capabilities = {
      ...this.capabilities,
      cwd: normalizedCwd,
      hasOsc7Cwd: true,
    };
    this.emit({ type: 'cwd', cwd: normalizedCwd, userInitiated });
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
          const cwd = this.expectedVisibleSyncCwd ?? promptInfo.cwd;
          this.applyCwdUpdate(cwd, false);
          this.processVisibleData(this.renderSuppressedPrompt(this.buildPromptForCwd(cwd)));
        } else if (fallbackPrompt) {
          const cwd = this.expectedVisibleSyncCwd ?? fallbackPrompt.cwd ?? this.currentCwd;
          this.applyCwdUpdate(cwd, false);
          this.processVisibleData(this.renderSuppressedPrompt(this.buildPromptForCwd(cwd)));
        } else if (!this.looksLikeSuppressedSyncEcho(buffered)) {
          this.processVisibleData(buffered);
        }
        this.emit({ type: 'sync-complete', cwd: this.currentCwd });
      }
    }, TerminalSession.syncSuppressionTimeoutMs);
  }

  private async performCwdSync(nextCwd: string): Promise<void> {
    if (this.ptyId === null || nextCwd === this.currentCwd) return;
    this.pendingCwdSync = null;
    this.currentCwd = nextCwd;
    this.capabilities = {
      ...this.capabilities,
      cwd: nextCwd,
    };
    this.emit({ type: 'cwd', cwd: nextCwd, userInitiated: false });
    this.emit({ type: 'sync-start', cwd: nextCwd });
    this.emitCapabilities();
    this.pendingVisibleSyncEcho = true;
    this.visibleSyncEchoBuffer = '';
    this.expectedVisibleSyncCwd = nextCwd;
    this.beginSyncSuppression();
    const syncCommand = buildCdCommand(nextCwd, this.capabilities.shellType);
    this.recentAutoSyncCommand = syncCommand.replace(/\r?\n$/, '');
    this.recentAutoSyncPrompt = this.buildPromptForCwd(nextCwd);
    this.recentAutoSyncExpiresAt = Date.now() + 2000;
    await bridge.pty.write(this.ptyId, syncCommand);
  }

  private flushPendingCwdSync(): void {
    const nextCwd = this.pendingCwdSync;
    if (!nextCwd) return;
    if (this.ptyId === null || this.capabilities.commandRunning || (this.inputBuffer.length > 0 && focusContext.is('terminal'))) {
      return;
    }
    void this.performCwdSync(nextCwd);
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
      return normalized.includes('cd /d "') || normalized.includes('@cd /d "');
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

  private renderSuppressedPrompt(prompt: string): string {
    const cleanedPrompt = prompt.trimEnd();
    if (!cleanedPrompt) {
      return '\r\x1b[2K';
    }

    if (this.capabilities.shellType === 'cmd' || this.capabilities.shellType === 'powershell') {
      return `\r\x1b[2K\x1b[1A\r\x1b[2K\x1b[1A\r\x1b[2K${cleanedPrompt}`;
    }

    return `\r\x1b[2K${cleanedPrompt}`;
  }

  private buildPromptForCwd(cwd: string): string {
    const shellPath = cwd.replace(/\//g, '\\');
    if (this.capabilities.shellType === 'powershell') {
      return `PS ${shellPath}>`;
    }
    if (this.capabilities.shellType === 'cmd') {
      return `${shellPath}>`;
    }
    return cwd;
  }

  private consumePendingVisibleSyncEcho(data: string): string {
    if (!this.pendingVisibleSyncEcho) return data;

    this.visibleSyncEchoBuffer += data;
    const buffered = this.visibleSyncEchoBuffer;
    const promptInfo = extractPromptInfo(buffered, this.capabilities.shellType);
    const fallbackPrompt = this.extractSuppressedPrompt(buffered);
    const looksLikeSync = this.looksLikeSuppressedSyncEcho(buffered);
    const resolvedPrompt = promptInfo ?? fallbackPrompt;
    const normalizedPromptCwd = resolvedPrompt?.cwd ? normalizeTerminalPath(resolvedPrompt.cwd) : null;
    const reachedExpectedPrompt =
      !!resolvedPrompt
      && !!normalizedPromptCwd
      && !!this.expectedVisibleSyncCwd
      && normalizedPromptCwd === this.expectedVisibleSyncCwd;

    if (reachedExpectedPrompt && looksLikeSync) {
      this.pendingVisibleSyncEcho = false;
      this.visibleSyncEchoBuffer = '';
      this.expectedVisibleSyncCwd = null;
      return this.renderSuppressedPrompt(resolvedPrompt?.prompt ?? '');
    }

    if (looksLikeSync) {
      if (buffered.length > 8192) {
        this.pendingVisibleSyncEcho = false;
        this.visibleSyncEchoBuffer = '';
        this.expectedVisibleSyncCwd = null;
        return '';
      }
      return '';
    }

    this.pendingVisibleSyncEcho = false;
    this.visibleSyncEchoBuffer = '';
    this.expectedVisibleSyncCwd = null;
    return buffered;
  }

  private sanitizeReplayData(data: string): string {
    if (!data) return data;

    let sanitized = data;
    sanitized = sanitized.replace(
      /(?:[A-Za-z]:\\[^\r\n>]*>\s*)@?cd \/d "[^"]+"(?:\r?\n)+([A-Za-z]:\\[^\r\n>]*>\s*)/g,
      '$1',
    );
    sanitized = sanitized.replace(
      /(?:[A-Za-z]:\\[^\r\n>]*>\s*)cd \/d "[^"]+"(?:\r?\n)+([A-Za-z]:\\[^\r\n>]*>\s*)/g,
      '$1',
    );
    sanitized = sanitized.replace(
      /(?:PS [^\r\n>]+>\s*)cd "(?:[^"`]|`.)+"(?:\r?\n)+(PS [^\r\n>]+>\s*)/g,
      '$1',
    );
    return sanitized.replace(/(\r?\n){3,}/g, '\r\n\r\n');
  }

  private sanitizeRecentAutoSyncEcho(data: string): string {
    if (!data || !this.recentAutoSyncCommand || Date.now() > this.recentAutoSyncExpiresAt) {
      if (Date.now() > this.recentAutoSyncExpiresAt) {
        this.recentAutoSyncCommand = null;
        this.recentAutoSyncPrompt = null;
      }
      return data;
    }

    if (
      data.includes(this.recentAutoSyncCommand)
      || data.includes(this.recentAutoSyncCommand.replace(/^@/, ''))
    ) {
      const prompt = this.recentAutoSyncPrompt ?? '';
      this.recentAutoSyncCommand = null;
      this.recentAutoSyncPrompt = null;
      this.recentAutoSyncExpiresAt = 0;
      return this.renderSuppressedPrompt(prompt);
    }

    const escapedCommand = this.recentAutoSyncCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedPrompt = (this.recentAutoSyncPrompt ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = data
      .replace(new RegExp(`(?:[A-Za-z]:\\\\[^\\r\\n>]*>\\s*)?${escapedCommand}(?:\\r?\\n)+${escapedPrompt}`, 'g'), this.recentAutoSyncPrompt ?? '')
      .replace(new RegExp(`(?:[A-Za-z]:\\\\[^\\r\\n>]*>\\s*)?${escapedCommand}(?:\\r?\\n)?`, 'g'), '')
      .replace(/(?:[A-Za-z]:\\[^\r\n>]*>\s*)cd \/d "[^"]+"(?:\r?\n)+([A-Za-z]:\\[^\r\n>]*>\s*)/g, '$1')
      .replace(/(?:[A-Za-z]:\\[^\r\n>]*>\s*)@cd \/d "[^"]+"(?:\r?\n)+([A-Za-z]:\\[^\r\n>]*>\s*)/g, '$1')
      .replace(/(?:[A-Za-z]:\\[^\r\n>]*>\s*)cd \/d "[^"]+"(?:\r?\n)?/g, '')
      .replace(/(?:[A-Za-z]:\\[^\r\n>]*>\s*)@cd \/d "[^"]+"(?:\r?\n)?/g, '')
      .replace(new RegExp(`${escapedPrompt}(?:\\r?\\n)+${escapedPrompt}`, 'g'), this.recentAutoSyncPrompt ?? '');

    if (stripped !== data && detectPrompt(stripped, this.capabilities.shellType)) {
      this.recentAutoSyncCommand = null;
      this.recentAutoSyncPrompt = null;
      this.recentAutoSyncExpiresAt = 0;
    }

    return stripped;
  }
}
