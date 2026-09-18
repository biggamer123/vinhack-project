#!/usr/bin/env node
/**
 * Restore the demo repository's own git history after a fresh clone.
 *
 * demo/ is a small repo-within-a-repo: its 32 commits by three authors are what
 * make churn and bus-factor real in the demo. A parent clone cannot carry a
 * nested .git, so the history ships as demo-history.bundle and is unpacked here.
 *
 *   npm run setup:demo
 *
 * Safe to re-run: it does nothing if demo/.git already exists.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const demoDir = path.join(repoRoot, 'demo');
const bundle = path.join(repoRoot, 'demo-history.bundle');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

if (fs.existsSync(path.join(demoDir, '.git'))) {
  const count = git(['rev-list', '--count', 'HEAD'], demoDir).trim();
  console.log(`demo/ already has its git history (${count} commits) — nothing to do.`);
  process.exit(0);
}
if (!fs.existsSync(bundle)) {
  console.error(`missing ${bundle} — cannot restore the demo history.`);
  process.exit(1);
}
if (!fs.existsSync(demoDir)) {
  console.error(`missing ${demoDir} — is this a complete clone?`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blast-radius-demo-'));
const clone = path.join(tmp, 'demo');
try {
  git(['clone', '--quiet', bundle, clone], repoRoot);
  fs.renameSync(path.join(clone, '.git'), path.join(demoDir, '.git'));

  // The bundle's HEAD and the checked-out demo files come from the same commit,
  // so the working tree should be clean. Say so if it is not.
  const dirty = git(['status', '--porcelain'], demoDir).trim();
  const count = git(['rev-list', '--count', 'HEAD'], demoDir).trim();
  const authors = git(['log', '--format=%an'], demoDir).trim().split('\n');
  console.log(`restored demo/ history: ${count} commits, ${new Set(authors).size} authors`);
  if (dirty) {
    console.log('note: demo/ has local modifications relative to that history:\n' + dirty);
  }
} catch (err) {
  console.error('failed to restore the demo history:', err.message);
  process.exit(1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
