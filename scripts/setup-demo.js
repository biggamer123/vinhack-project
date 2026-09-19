#!/usr/bin/env node
/**
 * Restore the demo repository's own git history after a fresh clone.
 *
 * demo/ is a repo-within-a-repo: its generated history (scripts/build-demo.js) is
 * what makes churn, bus factor, features, backups and the command log real in the
 * demo. A parent clone cannot carry a nested .git, so it is built here.
 *
 *   npm run setup:demo
 *
 * Safe to re-run: it does nothing if demo/.git already exists.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const demoDir = path.join(repoRoot, 'demo');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

if (fs.existsSync(path.join(demoDir, '.git'))) {
  const count = git(['rev-list', '--count', 'HEAD'], demoDir).trim();
  console.log(`demo/ already has its git history (${count} commits) — nothing to do.`);
  process.exit(0);
}
// Build the history from the files in demo/ (commits, branches, backups, coverage).
require('./build-demo.js');
