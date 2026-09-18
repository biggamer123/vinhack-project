/**
 * Blast Radius - backups inside VS Code.
 *
 * Owns the per-workspace opt-in, the interval timer, terminal command capture
 * and the snapshot of backups + command log the webview renders. The git work
 * itself lives in ./backups so it can be tested without an editor.
 */
import * as vscode from "vscode";
import {
  appendEvent,
  Backup,
  BACKUP_BRANCH,
  buildTimeline,
  classifyGitCommand,
  git,
  gitDirOf,
  hookStatus,
  HookStatus,
  installBackupSupport,
  listBackups,
  manualHookInstructions,
  readEvents,
  readReflog,
  removeBackupSupport,
  restoreCommands,
  RestoreCommands,
  runBackup,
  TimelineEntry,
} from "./backups";
import { findRepoRoot } from "./git";

const ENABLED_KEY = "blastradius.backups.enabled";

export interface BackupsPayload {
  available: boolean;
  reason?: string;
  enabled: boolean;
  branch: string;
  intervalMinutes: number;
  lastBackupAt: number | null;
  nextBackupAt: number | null;
  hooks: HookStatus | null;
  manualInstructions: string;
  terminalCapture: boolean;
  backups: (Backup & { commands: RestoreCommands })[];
  timeline: TimelineEntry[];
  error?: string;
}

export class BackupsController implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private nextRunAt: number | null = null;
  private repo: string | undefined;
  private gitDir: string | undefined;
  private identity = { name: "", email: "" };
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private disposables: vscode.Disposable[] = [];
  private lastError: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
  ) {}

  /** Resolve the repository and, if backups were enabled here before, resume them. */
  async start(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.repo = root ? await findRepoRoot(root) : undefined;
    this.gitDir = this.repo ? await gitDirOf(this.repo) : undefined;
    if (this.repo) {
      this.identity = {
        name: (await git(this.repo, ["config", "user.name"])).stdout.trim(),
        email: (await git(this.repo, ["config", "user.email"])).stdout.trim(),
      };
    }
    this.watchTerminals();
    if (this.isEnabled() && this.repo) {
      try {
        // Refresh scripts and hooks from this version of the extension.
        await installBackupSupport(this.repo, this.context.extensionPath);
        this.schedule();
        this.log(`backups resumed (every ${this.intervalMinutes()} min) on ${BACKUP_BRANCH}`);
      } catch (err) {
        this.lastError = String(err);
        this.log(`could not resume backups: ${err}`);
      }
    }
  }

  isEnabled(): boolean {
    return this.context.workspaceState.get<boolean>(ENABLED_KEY, false);
  }

  intervalMinutes(): number {
    const value = vscode.workspace.getConfiguration("blastradius").get<number>("backups.intervalMinutes", 10);
    return Math.max(1, Math.min(240, value || 10));
  }

  async enable(): Promise<void> {
    if (!this.repo) {
      vscode.window.showWarningMessage("Blast Radius: backups need the workspace to be a git repository.");
      return;
    }
    try {
      const status = await installBackupSupport(this.repo, this.context.extensionPath);
      await this.context.workspaceState.update(ENABLED_KEY, true);
      this.appendEvent({ t: Date.now(), kind: "enabled", name: this.identity.name, email: this.identity.email });
      if (status.managedExternally) {
        vscode.window.showWarningMessage(
          "Blast Radius: this repository uses core.hooksPath, so the push guard and commit backups were NOT installed " +
            "automatically. Add the lines shown in the BACKUPS tab to your hooks. Interval backups are running.",
        );
      }
      await this.backupNow("manual", "backups enabled");
      this.schedule();
      this.lastError = undefined;
    } catch (err) {
      this.lastError = String(err);
      vscode.window.showErrorMessage(`Blast Radius: could not enable backups - ${err}`);
    }
    this.changed.fire();
  }

  async disable(): Promise<void> {
    if (!this.repo) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "Turn off Blast Radius backups for this repository? Existing backups are kept on the " +
        `${BACKUP_BRANCH} branch; the hooks are removed and any hooks that were there before are put back.`,
      { modal: true },
      "Turn off",
    );
    if (choice !== "Turn off") {
      return;
    }
    this.stopTimer();
    await removeBackupSupport(this.repo);
    await this.context.workspaceState.update(ENABLED_KEY, false);
    this.appendEvent({ t: Date.now(), kind: "disabled", name: this.identity.name, email: this.identity.email });
    this.changed.fire();
  }

  async backupNow(trigger: "interval" | "manual" = "manual", note = ""): Promise<void> {
    if (!this.repo || !this.isEnabled()) {
      return;
    }
    const result = await runBackup(this.repo, trigger, note);
    if (result.error) {
      this.lastError = result.error;
      this.log(`backup failed: ${result.error}`);
    } else if (result.created) {
      this.log(`backup ${result.commit?.slice(0, 8)} (${trigger})`);
    }
    this.changed.fire();
  }

  private schedule(): void {
    this.stopTimer();
    const ms = this.intervalMinutes() * 60 * 1000;
    this.nextRunAt = Date.now() + ms;
    this.timer = setInterval(() => {
      this.nextRunAt = Date.now() + ms;
      void this.backupNow("interval");
    }, ms);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
    this.nextRunAt = null;
  }

  /**
   * Log git commands typed into VS Code terminals, with their exit codes. This
   * relies on terminal shell integration (on by default for bash, zsh, fish and
   * PowerShell); commands typed outside VS Code are only visible through the
   * reflog.
   */
  private watchTerminals(): void {
    const onEnd = (vscode.window as unknown as {
      onDidEndTerminalShellExecution?: vscode.Event<{
        execution: { commandLine: { value: string }; cwd?: vscode.Uri };
        exitCode: number | undefined;
      }>;
    }).onDidEndTerminalShellExecution;
    if (!onEnd) {
      return;
    }
    this.disposables.push(
      onEnd(async (event) => {
        if (!this.isEnabled() || !this.repo) {
          return;
        }
        const command = event.execution.commandLine.value.trim();
        if (!classifyGitCommand(command)) {
          return;
        }
        const head = (await git(this.repo, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
        this.appendEvent({
          t: Date.now(),
          kind: "terminal",
          command,
          exitCode: event.exitCode ?? null,
          cwd: event.execution.cwd?.fsPath,
          name: this.identity.name,
          email: this.identity.email,
          head,
        });
        this.changed.fire();
      }),
    );
  }

  terminalCaptureAvailable(): boolean {
    return typeof (vscode.window as unknown as { onDidEndTerminalShellExecution?: unknown })
      .onDidEndTerminalShellExecution === "function";
  }

  private appendEvent(event: Parameters<typeof appendEvent>[1]): void {
    if (this.gitDir) {
      try {
        appendEvent(this.gitDir, event);
      } catch (err) {
        this.log(`could not write the command log: ${err}`);
      }
    }
  }

  /** Everything the BACKUPS and COMMANDS tabs show. Read-only. */
  async snapshot(): Promise<BackupsPayload> {
    const base: BackupsPayload = {
      available: false,
      enabled: this.isEnabled(),
      branch: BACKUP_BRANCH,
      intervalMinutes: this.intervalMinutes(),
      lastBackupAt: null,
      nextBackupAt: this.nextRunAt,
      hooks: null,
      manualInstructions: manualHookInstructions(),
      terminalCapture: this.terminalCaptureAvailable(),
      backups: [],
      timeline: [],
      error: this.lastError,
    };
    if (!this.repo || !this.gitDir) {
      return { ...base, reason: "This workspace is not a git repository." };
    }
    try {
      const [backups, reflog, hooks] = await Promise.all([
        listBackups(this.repo),
        readReflog(this.repo),
        hookStatus(this.repo),
      ]);
      const events = readEvents(this.gitDir);
      return {
        ...base,
        available: true,
        hooks,
        lastBackupAt: backups.length ? backups[0].t : null,
        backups: backups.map((b) => ({ ...b, commands: restoreCommands(b.sha) })),
        timeline: buildTimeline(backups, reflog, events).slice(0, 1000),
      };
    } catch (err) {
      return { ...base, available: true, error: String(err) };
    }
  }

  dispose(): void {
    this.stopTimer();
    this.changed.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
