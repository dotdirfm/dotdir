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
    this.beginSyncSuppression();
    await bridge.pty.write(this.ptyId, buildCdCommand(nextCwd, this.capabilities.shellType));
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
        this.applyCwdUpdate(syncOscResult.cwd);
        if (syncOscResult.after) {
          this.processVisibleData(`\r\x1b[2K${syncOscResult.after}`);
        }
        return;
      }

      const promptInfo = extractPromptInfo(this.suppressedOutput, this.capabilities.shellType);
      if (!promptInfo) return;

      this.endSyncSuppression();
      if (promptInfo.cwd) {
        this.applyCwdUpdate(promptInfo.cwd);
      }
      this.processVisibleData(`\r\x1b[2K${promptInfo.prompt}`);
      return;
    }

    this.processVisibleData(data);
  }

  private processVisibleData(data: string): void {
    this.replayData = (this.replayData + data).slice(-TerminalSession.replayLimit);
    this.emit({ type: 'data', data });

    const cwdUpdates = extractOsc7Cwds(data);
    const latestCwd = cwdUpdates[cwdUpdates.length - 1];
    if (latestCwd) {
      this.applyCwdUpdate(latestCwd);
    } else {
      const promptInfo = extractPromptInfo(data, this.capabilities.shellType);
      if (promptInfo?.cwd) {
        this.applyCwdUpdate(promptInfo.cwd);
      }
    }

    if (detectPrompt(data, this.capabilities.shellType)) {
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
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
    }
    this.suppressTimer = setTimeout(() => {
      const buffered = this.suppressedOutput;
      this.endSyncSuppression();
      if (buffered) {
        const promptInfo = extractPromptInfo(buffered, this.capabilities.shellType);
        if (promptInfo?.cwd) {
          this.applyCwdUpdate(promptInfo.cwd);
          this.processVisibleData(`\r\x1b[2K${promptInfo.prompt}`);
        } else {
          this.processVisibleData(buffered);
        }
      }
    }, 2000);
  }

  private endSyncSuppression(): void {
    this.suppressSyncOutput = false;
    this.suppressedOutput = '';
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = null;
    }
  }
}
