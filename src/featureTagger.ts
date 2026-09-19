/**
 * Blast Radius - ask which feature a commit belongs to, right after committing.
 *
 * Watches `.git/logs/HEAD`, which git appends to on every commit. When a new
 * commit by the person working here appears, a picker offers the features this
 * repository already knows about - from the shared log and from commit messages
 * already written in the convention - plus "new feature". The answer is written
 * to .blastradius/FEATURES.md and committed with the code, so a teammate who
 * pulls sees the same features.
 *
 * Commit messages that already name a feature (`feature(comments): ...`) are
 * skipped: they tag themselves.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { COMMIT_TYPES, CommitType, parseCommitMessage } from "./features";
import {
  addToFeatureLog,
  FEATURE_LOG_DIR,
  FEATURE_LOG_PATH,
  formatFeatureLog,
  LoggedFeature,
  parseFeatureLog,
  taggedCommits,
} from "./featureLog";

const ASK_SETTING = "features.askOnCommit";
const SKIP = "$(circle-slash) Not part of a feature";
const NEW = "$(add) New feature…";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });
}

export class FeatureTagger {
  private watcher: fs.FSWatcher | undefined;
  private repo: string | undefined;
  private lastHead = "";
  private busy = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  async start(root: string): Promise<void> {
    this.stop();
    try {
      this.repo = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
      const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
      this.lastHead = await this.head();
      const log = path.join(gitDir, "logs", "HEAD");
      fs.mkdirSync(path.dirname(log), { recursive: true });
      if (!fs.existsSync(log)) {
        return; // no commits yet; the watcher would have nothing to watch
      }
      this.watcher = fs.watch(log, () => this.onHeadMoved());
    } catch {
      this.repo = undefined; // not a git repository
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stop();
  }

  private async head(): Promise<string> {
    return this.repo ? (await git(this.repo, ["rev-parse", "HEAD"])).trim() : "";
  }

  /** git writes the reflog in bursts; settle before reading. */
  private onHeadMoved(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.checkForNewCommit(), 700);
  }

  private async checkForNewCommit(): Promise<void> {
    if (!this.repo || this.busy) {
      return;
    }
    const enabled = vscode.workspace.getConfiguration("blastradius").get<boolean>(ASK_SETTING, true);
    if (!enabled) {
      return;
    }
    this.busy = true;
    try {
      const head = await this.head();
      if (!head || head === this.lastHead) {
        return;
      }
      const previous = this.lastHead;
      this.lastHead = head;
      // Only the commits this move added, and only those written here.
      const range = previous ? `${previous}..${head}` : "-1";
      const raw = await git(this.repo, ["log", "--no-merges", "--format=%H%x1f%s%x1f%an%x1f%aI", range]);
      const rows = raw.split(/\r?\n/).filter(Boolean).slice(0, 3);
      const me = (await git(this.repo, ["config", "user.email"]).catch(() => "")).trim().toLowerCase();
      for (const row of rows.reverse()) {
        const [hash, subject, who, iso] = row.split("\x1f");
        const author = (await git(this.repo, ["show", "-s", "--format=%ae", hash])).trim().toLowerCase();
        if (me && author && author !== me) {
          continue; // someone else's commit arrived through a pull
        }
        if (parseCommitMessage(subject)) {
          continue; // the message already names its feature
        }
        await this.ask({ hash: hash.slice(0, 8), subject, who, date: (iso || "").slice(0, 10) });
      }
    } catch (err) {
      this.output.appendLine(`feature tagger: ${err}`);
    } finally {
      this.busy = false;
    }
  }

  /** Read the log, ask, write it back. Also used by the manual command. */
  async ask(commit: { hash: string; subject: string; who: string; date: string }): Promise<void> {
    if (!this.repo) {
      return;
    }
    const file = path.join(this.repo, FEATURE_LOG_PATH);
    const existing: LoggedFeature[] = fs.existsSync(file)
      ? parseFeatureLog(fs.readFileSync(file, "utf8"))
      : [];

    const known = new Map<string, CommitType>();
    for (const feature of existing) {
      known.set(feature.name, feature.type);
    }
    // Features that already exist because their commit messages name them.
    try {
      const subjects = await git(this.repo, ["log", "--no-merges", "-n300", "--format=%s"]);
      for (const subject of subjects.split(/\r?\n/)) {
        const parsed = parseCommitMessage(subject);
        const name = parsed?.scope || parsed?.title;
        if (parsed && name && !known.has(name)) {
          known.set(name, parsed.type);
        }
      }
    } catch {
      // no history to learn from
    }

    const items: vscode.QuickPickItem[] = [
      { label: NEW, alwaysShow: true },
      ...[...known.entries()].map(([name, type]) => ({ label: name, description: type })),
      { label: SKIP, alwaysShow: true },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Which feature is ${commit.hash} part of?`,
      placeHolder: commit.subject,
      ignoreFocusOut: true,
    });
    if (!picked || picked.label === SKIP) {
      return;
    }

    let name = picked.label;
    let type: CommitType = (known.get(name) as CommitType) || "feature";
    if (picked.label === NEW) {
      const entered = await vscode.window.showInputBox({
        title: "New feature",
        prompt: "Name this feature. Commits tagged with it are grouped together.",
        value: commit.subject.replace(/^\w+(\([^)]*\))?:\s*/, ""),
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : "Give the feature a name"),
      });
      if (!entered) {
        return;
      }
      name = entered.trim();
      const pickedType = await vscode.window.showQuickPick([...COMMIT_TYPES], {
        title: `What kind of work is "${name}"?`,
        ignoreFocusOut: true,
      });
      type = (pickedType as CommitType) || "feature";
    }

    const updated = addToFeatureLog(
      existing,
      name,
      { hash: commit.hash, date: commit.date, who: commit.who, summary: commit.subject },
      type,
    );
    fs.mkdirSync(path.join(this.repo, FEATURE_LOG_DIR), { recursive: true });
    fs.writeFileSync(file, formatFeatureLog(updated));
    this.output.appendLine(`feature tagger: ${commit.hash} -> ${name}`);

    const action = await vscode.window.showInformationMessage(
      `${commit.hash} is part of "${name}". Saved in ${FEATURE_LOG_PATH} - commit it so your team sees it too.`,
      "Stage the file",
      "Open it",
    );
    if (action === "Stage the file") {
      await git(this.repo, ["add", "--", FEATURE_LOG_PATH]);
    } else if (action === "Open it") {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    }
  }

  /** "Tag a commit to a feature…" - pick any recent commit, then a feature. */
  async tagExistingCommit(): Promise<void> {
    if (!this.repo) {
      vscode.window.showWarningMessage("Blast Radius: this folder is not a git repository.");
      return;
    }
    const file = path.join(this.repo, FEATURE_LOG_PATH);
    const done = fs.existsSync(file) ? taggedCommits(parseFeatureLog(fs.readFileSync(file, "utf8"))) : new Map();
    const raw = await git(this.repo, ["log", "--no-merges", "-n50", "--format=%H%x1f%s%x1f%an%x1f%aI"]);
    const items = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((row) => {
        const [hash, subject, who, iso] = row.split("\x1f");
        const short = hash.slice(0, 8);
        const parsed = parseCommitMessage(subject);
        const already = parsed ? parsed.scope || parsed.title : done.get(short)?.name;
        return {
          label: subject,
          description: `${short} · ${who}`,
          detail: already ? `already in "${already}"` : undefined,
          commit: { hash: short, subject, who, date: (iso || "").slice(0, 10) },
        };
      });
    const picked = await vscode.window.showQuickPick(items, {
      title: "Tag a commit to a feature",
      placeHolder: "Pick a commit",
      ignoreFocusOut: true,
    });
    if (picked) {
      await this.ask(picked.commit);
    }
  }
}
