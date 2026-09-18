/**
 * Dev helper: prove the backups feature is safe, against real repositories.
 *
 *   npm run compile && node scripts/check-backups.js
 *
 * Everything happens in throwaway repos under the OS temp dir, with a local
 * bare repository standing in for GitHub. Nothing touches the repo you run it
 * from. It checks that:
 *   - a backup leaves HEAD, the index and every working file untouched
 *   - the backup branch never reaches the remote, however the push is written
 *   - the other refs in such a push still arrive, forced pushes included
 *   - a pre-existing pre-push hook still gets its say
 *   - the restore command brings back the backed-up state, and is undoable
 *   - disabling puts the original hooks back
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const backups = require("../out/backups");

const EXT = path.join(__dirname, "..");
let failures = 0;
function check(label, actual, expected) {
  const ok = expected === undefined ? !!actual : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`,
  );
}

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Ada Reyes",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada Reyes",
  GIT_COMMITTER_EMAIL: "ada@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};
function g(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gTry(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function sh(cwd, command) {
  const r = spawnSync("sh", ["-c", command], { cwd, env: ENV, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const remoteHas = (bare, ref) => gTry(bare, "rev-parse", "-q", "--verify", ref).code === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshRepo(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `blast-radius-backups-${label}-`));
  const repo = path.join(root, "work");
  const bare = path.join(root, "github.git");
  fs.mkdirSync(repo);
  g(root, "init", "-q", "--bare", bare);
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.name", "Ada Reyes");
  g(repo, "config", "user.email", "ada@example.com");
  g(repo, "remote", "add", "origin", bare);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.env\n");
  fs.writeFileSync(path.join(repo, "app.js"), "function main() {\n  return 1;\n}\n");
  fs.writeFileSync(path.join(repo, "lib.js"), "function helper() {\n  return 2;\n}\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "feature: initial app");
  return { root, repo, bare };
}

function snapshotState(repo) {
  const files = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files[path.relative(repo, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(repo);
  return {
    head: g(repo, "rev-parse", "HEAD"),
    branch: g(repo, "symbolic-ref", "--short", "HEAD"),
    status: g(repo, "status", "--porcelain"),
    staged: g(repo, "diff", "--cached", "--name-status"),
    files,
  };
}

async function main() {
  // ================================================================ backups
  {
    const { repo } = freshRepo("snapshot");
    const status = await backups.installBackupSupport(repo, EXT);
    check("hooks installed", [status.prePush, status.postCommit], ["installed", "installed"]);
    check("scripts copied into .git", status.scriptsPresent, true);

    // messy in-progress work: modified, staged, new untracked, ignored
    fs.writeFileSync(path.join(repo, "app.js"), "function main() {\n  return 42;\n}\n");
    fs.writeFileSync(path.join(repo, "lib.js"), "function helper() {\n  return 3;\n}\n");
    g(repo, "add", "lib.js");
    fs.writeFileSync(path.join(repo, "new-file.js"), "function fresh() {}\n");
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    const before = snapshotState(repo);

    const first = await backups.runBackup(repo, "manual", "check");
    check("backup created", first.created, true);
    check("backup leaves HEAD, index, status and files untouched", snapshotState(repo), before);
    check("backup branch exists", gTry(repo, "rev-parse", "-q", "--verify", backups.BACKUP_REF).code, 0);

    const tree = g(repo, "ls-tree", "-r", "--name-only", backups.BACKUP_REF).split("\n");
    check("backup includes new untracked files", tree.includes("new-file.js"), true);
    check("backup respects .gitignore", tree.includes(".env"), false);
    check("backup captures unstaged edits", g(repo, "show", `${backups.BACKUP_REF}:app.js`).includes("42"), true);
    check("backup captures staged edits", g(repo, "show", `${backups.BACKUP_REF}:lib.js`).includes("3"), true);

    const again = await backups.runBackup(repo, "interval");
    check("unchanged tree does not create a duplicate backup", again.created, false);

    fs.writeFileSync(path.join(repo, "app.js"), "function main() {\n  return 43;\n}\n");
    const second = await backups.runBackup(repo, "interval");
    check("changed tree creates a new backup", second.created, true);

    const list = await backups.listBackups(repo);
    check("backups listed newest first", list.map((b) => b.trigger), ["interval", "manual"]);
    check("backup records the HEAD it was taken on", list[0].head, before.head);
    check("backup records the branch", list[0].branch, "main");
    check("backup records uncommitted file count", list[0].uncommittedFiles, 3);
    check("backup links the HEAD commit's feature", list[0].feature && list[0].feature.name, "initial app");
    check("backup author is the local user", list[0].author, "Ada Reyes");

    // post-commit hook
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "bug fix: return the right number");
    let afterCommit = [];
    for (let i = 0; i < 40; i++) {
      afterCommit = await backups.listBackups(repo);
      if (afterCommit.length > list.length) break;
      await sleep(150);
    }
    check("committing triggers a backup via the post-commit hook", afterCommit[0] && afterCommit[0].trigger, "commit");
    check("commit backup knows its feature", afterCommit[0] && afterCommit[0].feature && afterCommit[0].feature.type, "bug fix");
  }

  // ============================================================= push guard
  {
    const { repo, bare } = freshRepo("push");
    await backups.installBackupSupport(repo, EXT);
    g(repo, "branch", "feature-x");
    fs.writeFileSync(path.join(repo, "app.js"), "function main() {\n  return 7;\n}\n");
    await backups.runBackup(repo, "manual");
    check("setup: backup branch exists locally", gTry(repo, "rev-parse", "-q", "--verify", backups.BACKUP_REF).code, 0);

    const plain = gTry(repo, "push", "-q", "origin", "main");
    check("plain push succeeds", plain.code, 0);
    check("plain push delivers main", remoteHas(bare, "refs/heads/main"), true);
    check("plain push does not deliver the backup branch", remoteHas(bare, backups.BACKUP_REF), false);

    const explicit = gTry(repo, "push", "origin", backups.BACKUP_BRANCH);
    check("pushing the backup branch by name is refused", explicit.code !== 0, true);
    check("...and explains why", /local-only/.test(explicit.out), true);
    check("...and it never reaches the remote", remoteHas(bare, backups.BACKUP_REF), false);

    const refspec = gTry(repo, "push", "origin", `${backups.BACKUP_BRANCH}:refs/heads/sneaky`);
    check("pushing it under another name is refused", refspec.code !== 0, true);
    check("...and the other name never appears", remoteHas(bare, "refs/heads/sneaky"), false);

    const all = gTry(repo, "push", "--all", "origin");
    check("push --all withholds the backup branch", remoteHas(bare, backups.BACKUP_REF), false);
    check("push --all still delivers the other branches", remoteHas(bare, "refs/heads/feature-x"), true);
    check("push --all says what happened", /pushing everything else/.test(all.out), true);

    // forced push of a rewritten branch, alongside the backup branch
    g(repo, "commit", "-q", "--amend", "-m", "feature: initial app (amended)");
    const amended = g(repo, "rev-parse", "HEAD");
    const forced = gTry(repo, "push", "--force", "--all", "origin");
    check("forced --all updates the rewritten branch", g(bare, "rev-parse", "refs/heads/main"), amended);
    check("forced --all still withholds the backup branch", remoteHas(bare, backups.BACKUP_REF), false);
    void forced;

    // a non-forced push of a rewritten branch must still be rejected as usual
    g(repo, "commit", "-q", "--amend", "-m", "feature: initial app (amended twice)");
    const unforced = gTry(repo, "push", "origin", "main");
    check("non-forced rewrite is still rejected by git", unforced.code !== 0, true);
    check("...and the remote keeps its commit", g(bare, "rev-parse", "refs/heads/main"), amended);

    const mirror = gTry(repo, "push", "--mirror", "origin");
    check("push --mirror withholds the backup branch", remoteHas(bare, backups.BACKUP_REF), false);
    void mirror;

    const log = backups.readEvents(await backups.gitDirOf(repo));
    check("push guard interventions are logged", log.filter((e) => e.kind === "push-guard").length >= 3, true);
  }

  // ========================================================= hook chaining
  {
    const { repo, bare } = freshRepo("chain");
    const hooks = g(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const original = "#!/bin/sh\necho ORIGINAL-HOOK-RAN >&2\n[ -f \"$(git rev-parse --show-toplevel)/.block-push\" ] && exit 1\nexit 0\n";
    fs.writeFileSync(path.join(hooks, "pre-push"), original);
    fs.chmodSync(path.join(hooks, "pre-push"), 0o755);

    const status = await backups.installBackupSupport(repo, EXT);
    check("existing hook is chained, not overwritten", status.chained, ["pre-push"]);

    const ok = gTry(repo, "push", "origin", "main");
    check("chained hook still runs", /ORIGINAL-HOOK-RAN/.test(ok.out), true);
    check("push proceeds when the chained hook allows it", remoteHas(bare, "refs/heads/main"), true);

    fs.writeFileSync(path.join(repo, ".block-push"), "");
    fs.writeFileSync(path.join(repo, "lib.js"), "function helper() {\n  return 9;\n}\n");
    g(repo, "add", "lib.js");
    g(repo, "commit", "-q", "-m", "chore: blocked");
    const blocked = gTry(repo, "push", "origin", "main");
    check("chained hook can still refuse a push", blocked.code !== 0, true);

    await backups.removeBackupSupport(repo);
    check("disabling restores the original hook", fs.readFileSync(path.join(hooks, "pre-push"), "utf8"), original);
    check("disabling leaves no chained copy behind", fs.existsSync(path.join(hooks, "pre-push.blastradius-chained")), false);
    check("disabling keeps the backups", gTry(repo, "rev-parse", "-q", "--verify", backups.BACKUP_REF).code, 0);
  }

  // ======================================================== core.hooksPath
  {
    const { repo } = freshRepo("hookspath");
    g(repo, "config", "core.hooksPath", ".husky");
    const status = await backups.installBackupSupport(repo, EXT);
    check("core.hooksPath is detected", status.managedExternally, true);
    check("nothing is written into a versioned hooks folder", fs.existsSync(path.join(repo, ".husky", "pre-push")), false);
    check("manual instructions are available", backups.manualHookInstructions().includes("pre-push.sh"), true);
  }

  // =============================================================== restore
  {
    const { repo } = freshRepo("restore");
    await backups.installBackupSupport(repo, EXT);
    fs.writeFileSync(path.join(repo, "app.js"), "function main() {\n  return 'good';\n}\n");
    fs.writeFileSync(path.join(repo, "notes.js"), "function notes() {}\n");
    await backups.runBackup(repo, "manual", "known good");
    const good = (await backups.listBackups(repo))[0];
    const goodFiles = snapshotState(repo).files;

    // irreversible-looking damage
    fs.rmSync(path.join(repo, "lib.js"));
    fs.rmSync(path.join(repo, "notes.js"));
    fs.writeFileSync(path.join(repo, "app.js"), "BROKEN\n");
    fs.writeFileSync(path.join(repo, "junk.js"), "function junk() {}\n");
    g(repo, "add", "-A");
    const damagedFiles = snapshotState(repo).files;
    const headBefore = g(repo, "rev-parse", "HEAD");

    const cmds = backups.restoreCommands(good.sha);
    const preview = sh(repo, cmds.preview);
    check("preview command runs", preview.code, 0);
    check("preview lists what would change", /app\.js/.test(preview.out), true);

    const exact = sh(path.join(repo), cmds.exact);
    check("exact restore command runs", exact.code, 0);
    check("exact restore announces the safety backup", /safety backup/.test(exact.out), true);
    check("files match the backup exactly", snapshotState(repo).files, goodFiles);
    check("restore does not move HEAD", g(repo, "rev-parse", "HEAD"), headBefore);

    // undo the restore using the safety backup it took
    const safety = (await backups.listBackups(repo))[0];
    check("a pre-restore backup was recorded", safety.trigger, "pre-restore");
    const undo = sh(repo, backups.restoreCommands(safety.sha).exact);
    check("undo command runs", undo.code, 0);
    check("undo returns the damaged state exactly", snapshotState(repo).files, damagedFiles);

    // non-exact restore keeps extra files
    const { repo: repo2 } = freshRepo("restore-keep");
    await backups.installBackupSupport(repo2, EXT);
    await backups.runBackup(repo2, "manual");
    const base = (await backups.listBackups(repo2))[0];
    fs.writeFileSync(path.join(repo2, "app.js"), "BROKEN\n");
    fs.writeFileSync(path.join(repo2, "keep-me.js"), "x\n");
    const plainRestore = sh(repo2, backups.restoreCommands(base.sha).restore);
    check("plain restore runs", plainRestore.code, 0);
    check("plain restore repairs tracked files", fs.readFileSync(path.join(repo2, "app.js"), "utf8").includes("return 1"), true);
    check("plain restore leaves untracked files alone", fs.existsSync(path.join(repo2, "keep-me.js")), true);

    // from a subdirectory
    fs.mkdirSync(path.join(repo2, "sub"));
    fs.writeFileSync(path.join(repo2, "app.js"), "BROKEN AGAIN\n");
    const fromSub = sh(path.join(repo2, "sub"), backups.restoreCommands(base.sha).restore);
    check("restore works from a subdirectory", fromSub.code, 0);
    check("...restoring the whole repository", fs.readFileSync(path.join(repo2, "app.js"), "utf8").includes("return 1"), true);

    // safety backup missing -> restore must not run
    const { repo: repo3 } = freshRepo("restore-guard");
    await backups.installBackupSupport(repo3, EXT);
    await backups.runBackup(repo3, "manual");
    const base3 = (await backups.listBackups(repo3))[0];
    fs.writeFileSync(path.join(repo3, "app.js"), "UNSAVED WORK\n");
    fs.rmSync(path.join(g(repo3, "rev-parse", "--absolute-git-dir"), "blastradius", "backup.sh"));
    const guarded = sh(repo3, backups.restoreCommands(base3.sha).exact);
    check("restore refuses to run without a safety backup", guarded.code !== 0, true);
    check("...and unsaved work is untouched", fs.readFileSync(path.join(repo3, "app.js"), "utf8"), "UNSAVED WORK\n");
  }

  // ============================================================ command log
  {
    const c = backups.classifyGitCommand;
    check("reset --hard is destructive", c("git reset --hard HEAD~2").risk, "destructive");
    check("clean -fd is destructive", c("git clean -fd").risk, "destructive");
    check("checkout -- . is destructive", c("git checkout -- .").risk, "destructive");
    check("restore is destructive", c("git restore src/app.js").risk, "destructive");
    check("restore --staged alone is not", c("git restore --staged src/app.js").risk, "safe");
    check("stash drop is destructive", c("git stash drop").risk, "destructive");
    check("branch -D is destructive", c("git branch -D old").risk, "destructive");
    check("push --force rewrites", c("git push --force origin main").risk, "rewrite");
    check("push -f rewrites", c("git push -f").risk, "rewrite");
    check("rebase rewrites", c("git rebase -i HEAD~3").risk, "rewrite");
    check("commit --amend rewrites", c("git commit --amend").risk, "rewrite");
    check("plain push is remote", c("git push origin main").risk, "remote");
    check("checkout branch moves head", c("git checkout develop").risk, "moves-head");
    check("status is safe", c("git status").risk, "safe");
    check("non-git commands are ignored", c("npm install"), null);

    const r = backups.classifyReflog;
    check("reflog reset is destructive", r("reset: moving to HEAD~2").risk, "destructive");
    check("reflog amend rewrites", r("commit (amend): fix").risk, "rewrite");
    check("reflog rebase rewrites", r("rebase (finish): returning to refs/heads/main").risk, "rewrite");
    check("reflog commit is safe", r("commit: feature: x").risk, "safe");

    const { repo } = freshRepo("timeline");
    await backups.installBackupSupport(repo, EXT);
    await backups.runBackup(repo, "manual");
    await sleep(1100);
    fs.writeFileSync(path.join(repo, "app.js"), "function main() {\n  return 5;\n}\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "feature(users): get users from db");
    await sleep(1100);
    g(repo, "reset", "-q", "--hard", "HEAD~1");
    const gitDir = await backups.gitDirOf(repo);
    backups.appendEvent(gitDir, { t: Date.now(), kind: "terminal", command: "git reset --hard HEAD~1", exitCode: 0, name: "Ada Reyes", email: "ada@example.com" });
    await sleep(300);

    const timeline = backups.buildTimeline(
      await backups.listBackups(repo),
      await backups.readReflog(repo),
      backups.readEvents(gitDir),
    );
    const resetEntry = timeline.find((e) => e.source === "reflog" && /^reset/.test(e.title));
    check("reflog reset appears in the timeline", !!resetEntry, true);
    check("reset is flagged destructive", resetEntry && resetEntry.risk, "destructive");
    check("reset links to a restore point taken before it", !!(resetEntry && resetEntry.restorePoint), true);
    const commitEntry = timeline.find((e) => e.source === "reflog" && /^commit:/.test(e.title));
    check("commit entry carries its feature", commitEntry && commitEntry.feature && commitEntry.feature.name, "users");
    const term = timeline.find((e) => e.source === "terminal");
    check("terminal command appears with its exit code", term && term.exitCode, 0);
    check("terminal command is classified", term && term.risk, "destructive");
    check("timeline is newest first", timeline.every((e, i) => i === 0 || timeline[i - 1].t >= e.t), true);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall backup checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
