import { focusContext } from "../focusContext";
import { Bridge, PtyLaunchInfo, TerminalProfile } from "../shared/api/bridge";
import { formatHiddenCd, normalizeTerminalPath } from "./path";
import type { TerminalCapabilities, TerminalSessionEvent, TerminalSessionStatus } from "./types";

type SessionListener = (event: TerminalSessionEvent) => void;

export class TerminalSession {
  private static readonly replayLimit = 64 * 1024;
  private readonly listeners = new Set<SessionListener>();
  private readonly decoder = new TextDecoder();
  private readonly initialCwd: string;
  private ptyId: number | null = null;
  private currentCwd: string;
  private status: TerminalSessionStatus = "idle";
  private capabilities: TerminalCapabilities;
  private launchInfo: PtyLaunchInfo | null = null;
  private replayData = "";
  private inputBuffer = "";
  private activeCommand: string | null = null;
  private suppressNextCommandFinish = false;
  private cleanupData: (() => void) | null = null;
  private cleanupExit: (() => void) | null = null;
  private pendingCwdSync: string | null = null;
  private readonly profile: TerminalProfile;
  /** While true, xterm OSC hooks must not mutate session state (replay buffer re-written to the terminal). */
  private oscHooksSuppressed = false;

  constructor(private bridge: Bridge, initialCwd: string, profile: TerminalProfile) {
    const normalizedInitialCwd = normalizeTerminalPath(initialCwd);
    this.initialCwd = normalizedInitialCwd;
    this.profile = profile;
    this.currentCwd = normalizedInitialCwd;
    this.capabilities = {
      cwd: normalizedInitialCwd,
      profileId: profile.id,
      hasOsc7Cwd: false,
      hasDotDirOsc: false,
      promptReady: false,
      commandRunning: false,
      lastCommand: null,
    };
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    if (this.launchInfo) {
      listener({ type: "launch", launch: this.launchInfo });
    }
    listener({ type: "status", status: this.status });
    listener({ type: "capabilities", capabilities: this.capabilities });
    if (this.replayData) {
      listener({ type: "data", data: this.replayData });
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

  setOscHooksSuppressed(suppressed: boolean): void {
    this.oscHooksSuppressed = suppressed;
  }

  /** xterm OSC 7 — cwd from shell integration. */
  notifyOsc7FromXterm(cwd: string): void {
    if (this.oscHooksSuppressed) return;
    this.applyCwdUpdate(normalizeTerminalPath(cwd), this.capabilities.commandRunning);
  }

  /**
   * .dir OSC 779 — shell integration emits this on preexec (S) and command finish (F).
   * Payload `S` = command starting (preexec); `F` = command finished (postexec / precmd).
   */
  notifyDotDirPromptOsc(payload: string): void {
    if (this.oscHooksSuppressed) return;
    const body = payload.replace(/^;/, "").trimStart();
    if (body.startsWith("S")) {
      // preexec: a user command is about to run (not fired for hidden cd — suppress flag is set)
      if (!this.suppressNextCommandFinish) {
        if (!this.capabilities.hasDotDirOsc) {
          this.capabilities = { ...this.capabilities, hasDotDirOsc: true };
        }
        if (!this.capabilities.commandRunning) {
          this.capabilities = { ...this.capabilities, commandRunning: true, promptReady: false };
        }
        this.emitCapabilities();
      }
      return;
    }
    if (!body.startsWith("F")) return;
    if (!this.capabilities.hasDotDirOsc) {
      this.capabilities = { ...this.capabilities, hasDotDirOsc: true };
      this.emitCapabilities();
    }
    this.finishCommand();
  }

  async start(): Promise<void> {
    if (this.ptyId !== null || this.status === "starting") return;

    this.setStatus("starting");
    try {
      const launch = await this.bridge.pty.spawn(this.initialCwd, this.profile.shell, {
        spawnArgs: this.profile.spawnArgs.length > 0 ? this.profile.spawnArgs : undefined,
      });
      this.acceptLaunch(launch);

      this.cleanupData = this.bridge.pty.onData((ptyId, data) => {
        if (ptyId !== this.ptyId) return;
        this.handleData(typeof data === "string" ? data : this.decoder.decode(data, { stream: true }));
      });

      this.cleanupExit = this.bridge.pty.onExit((ptyId) => {
        if (ptyId !== this.ptyId) return;
        if (this.activeCommand) {
          this.emit({ type: "command-finish", command: this.activeCommand });
        }
        this.activeCommand = null;
        this.capabilities = {
          ...this.capabilities,
          commandRunning: false,
          promptReady: false,
        };
        this.emitCapabilities();
        this.ptyId = null;
        this.setStatus("exited");
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
      throw error;
    }
  }

  async write(data: string): Promise<void> {
    if (this.ptyId === null) return;
    this.consumeUserInput(data);
    await this.bridge.pty.write(this.ptyId, data);
  }

  /**
   * Write to the PTY without tracking as user input (used for hidden `cd`).
   * The next OSC 779 (prompt after this line) is ignored for command-finish.
   */
  async writeHidden(data: string): Promise<void> {
    if (this.ptyId === null) return;
    this.suppressNextCommandFinish = true;
    await this.bridge.pty.write(this.ptyId, data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.ptyId === null) return;
    await this.bridge.pty.resize(this.ptyId, Math.max(2, cols), Math.max(1, rows));
  }

  async syncToCwd(nextCwd: string): Promise<void> {
    const normalizedNextCwd = normalizeTerminalPath(nextCwd);
    if (this.ptyId === null || normalizedNextCwd === this.currentCwd) return;
    if (this.capabilities.commandRunning || (this.inputBuffer.length > 0 && focusContext.is("terminal"))) {
      this.pendingCwdSync = normalizedNextCwd;
      return;
    }
    this.pendingCwdSync = null;
    await this.writeHidden(formatHiddenCd(normalizedNextCwd, this.profile));
  }

  async refreshPrompt(): Promise<void> {
    if (this.ptyId === null) return;
    if (this.capabilities.commandRunning) return;
    await this.bridge.pty.write(this.ptyId, "\r");
  }

  async dispose(): Promise<void> {
    this.cleanupData?.();
    this.cleanupData = null;
    this.cleanupExit?.();
    this.cleanupExit = null;
    this.pendingCwdSync = null;

    if (this.ptyId !== null) {
      const id = this.ptyId;
      this.ptyId = null;
      await this.bridge.pty.close(id);
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
      profileId: this.profile.id,
    };

    this.emit({ type: "launch", launch });
    this.emitCapabilities();
    this.setStatus("running");
  }

  private handleData(data: string): void {
    this.appendVisibleData(data);
  }

  private appendVisibleData(data: string): void {
    if (!data) return;
    this.replayData = (this.replayData + data).slice(-TerminalSession.replayLimit);
    this.emit({ type: "data", data });
  }

  private finishCommand(): void {
    // After a hidden `cd`, the first OSC 779 is prompt-ready for that line only — ignore it
    // and keep tracking the user's command until the next OSC 779.
    if (this.suppressNextCommandFinish) {
      this.suppressNextCommandFinish = false;
      return;
    }
    if (this.activeCommand) {
      this.emit({ type: "command-finish", command: this.activeCommand });
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
    this.emit({ type: "cwd", cwd: normalizedCwd, userInitiated });
    this.emitCapabilities();
  }

  private consumeUserInput(data: string): void {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const command = this.inputBuffer.trim();
        this.inputBuffer = "";
        if (!command) continue;
        this.activeCommand = command;
        this.capabilities = {
          ...this.capabilities,
          commandRunning: true,
          promptReady: false,
          lastCommand: command,
        };
        this.emit({ type: "command-start", command });
        this.emitCapabilities();
      } else if (ch === "\u007f" || ch === "\b") {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
      } else if (ch >= " " || ch === "\t") {
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
    this.emit({ type: "capabilities", capabilities: this.capabilities });
  }

  private setStatus(status: TerminalSessionStatus, error?: string): void {
    this.status = status;
    this.emit({ type: "status", status, error });
  }

  private flushPendingCwdSync(): void {
    const nextCwd = this.pendingCwdSync;
    if (!nextCwd) return;
    if (this.ptyId === null || this.capabilities.commandRunning || (this.inputBuffer.length > 0 && focusContext.is("terminal"))) {
      return;
    }
    this.pendingCwdSync = null;
    void this.writeHidden(formatHiddenCd(nextCwd, this.profile));
  }
}
