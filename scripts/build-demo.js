#!/usr/bin/env node
/**
 * Build the demo repository's git history from the files in demo/.
 *
 * demo/ holds the final version of every file. This script replays how that code
 * came to be - about 65 commits over seven months by six people - so every
 * Blast Radius view has real data:
 *
 *   - churn and bus factor: hotspots are edited again and again (EDITS below
 *     lists each line's earlier versions; commits step through them)
 *   - features: most commits follow `type(scope): title`; a few do not
 *   - identities: one PR is merged the GitHub way, under a noreply email
 *   - backups: snapshots on refs/heads/blastradiusbackups, taken with the real
 *     media/hooks/backup.sh, some with uncommitted work
 *   - command log: branches, merges, a cherry-pick, an amend, a hard reset and a
 *     stash land in the reflog; a few terminal commands in the events log
 *   - coverage: coverage/lcov.info is generated from the final sources, with
 *     some functions fully covered, some partly and many not at all
 *
 * Dates are relative to when the script runs, so churn "in the last 90 days"
 * stays true. The repository is built in a temp directory and its .git is moved
 * into demo/ at the end.
 *
 *   node scripts/build-demo.js           # only if demo/ has no .git yet
 *   node scripts/build-demo.js --force   # replace demo/.git
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const demoDir = path.join(repoRoot, 'demo');
const backupScript = path.join(repoRoot, 'media', 'hooks', 'backup.sh');
const force = process.argv.includes('--force');

/* ---------------------------------------------------------------- people */

const PEOPLE = {
  ada: { name: 'Ada Reyes', email: 'ada@example.com' },
  sam: { name: 'Sam Okafor', email: 'sam@example.com' },
  priya: { name: 'Priya Nair', email: 'priya@example.com' },
  leo: { name: 'Leo Park', email: 'leo@example.com' },
  // The same Leo, committing through GitHub's web UI.
  leoWeb: { name: 'Leo Park', email: '41203311+leopark@users.noreply.github.com' },
  mina: { name: 'Mina Kowalski', email: 'mina@example.com' },
  jonah: { name: 'Jonah Lee', email: 'jonah@example.com' },
  github: { name: 'GitHub', email: 'noreply@github.com' },
};

/* ----------------------------------------------------------------- edits */

// Each edit names a piece of text as it is in the final file, and the versions it
// had before. A file is first committed with steps[0]; every commit that lists
// the edit moves it one version on; after the last step it is the final text.
const EDITS = {
  legacyWidth: { file: 'src/legacy.js', final: 'options.width : 44;', steps: ['options.width : 32;', 'options.width : 36;', 'options.width : 40;', 'options.width : 48;', 'options.width : 42;'] },
  emitRule: {
    file: 'src/telemetry.js',
    final: "return !event.startsWith('debug') && event.length > 5;",
    steps: ['return true;', "return !event.startsWith('debug');", "return !event.startsWith('debug') && event.length > 2;", "return !event.startsWith('debug') && event.length > 4;"],
  },
  eventFormat: {
    file: 'src/telemetry.js',
    final: 'return `[${event}] ` + JSON.stringify(payload || {});',
    steps: ["return event + ' ' + JSON.stringify(payload);", 'return `[${event}] ` + JSON.stringify(payload);'],
  },
  auditEntry: {
    file: 'src/audit.js',
    final: 'const entry = { actor, action, target, at: Date.now(), v: 3 };',
    steps: ['const entry = { actor, action, target };', 'const entry = { actor, action, target, at: Date.now() };'],
  },
  bucketCapacity: { file: 'src/rateLimit.js', final: 'const CAPACITY = 120;', steps: ['const CAPACITY = 60;', 'const CAPACITY = 300;'] },
  bucketRefill: { file: 'src/rateLimit.js', final: 'const REFILL_PER_SECOND = 2;', steps: ['const REFILL_PER_SECOND = 1;'] },
  blockedWords: {
    file: 'src/comments.js',
    final: "const BLOCKED_WORDS = ['casino', 'free money', 'crypto giveaway'];",
    steps: ["const BLOCKED_WORDS = ['casino'];", "const BLOCKED_WORDS = ['casino', 'free money'];"],
  },
  spamLinks: { file: 'src/comments.js', final: '|| []).length > 2;', steps: ['|| []).length > 5;', '|| []).length > 3;'] },
  sessionTtl: { file: 'src/auth/session.js', final: 'const DEFAULT_TTL_HOURS = 72;', steps: ['const DEFAULT_TTL_HOURS = 168;'] },
  cookieFlags: {
    file: 'src/auth/session.js',
    final: '`sid=${session.token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`',
    steps: ['`sid=${session.token}; Path=/; Max-Age=${maxAge}`', '`sid=${session.token}; HttpOnly; Path=/; Max-Age=${maxAge}`'],
  },
  pbkdf2: { file: 'src/auth/password.js', final: 'const ITERATIONS = 210000;', steps: ['const ITERATIONS = 100000;'] },
  titleWeight: { file: 'src/search.js', final: 'score += 3;', steps: ['score += 2;'] },
  notFound: { file: 'src/api.js', final: 'return notFound(); // fallthrough', steps: ['return { status: 404, data: null };'] },
  exportWidth: { file: 'src/api.js', final: 'legacyExport(store, { width: 60 })', steps: ['legacyExport(store, { width: 44 })'] },
  cacheHit: { file: 'src/cache.js', final: 'if (hit !== null) {', steps: ['if (hit) {'] },
  rssOrder: { file: 'src/feed/rss.js', final: 'listPosts(store).slice(-20).reverse()', steps: ['listPosts(store).reverse()'] },
  mailRetries: { file: 'services/mailer/internal/queue/consumer.go', final: 'const maxAttempts = 5', steps: ['const maxAttempts = 3'] },
  readingTime: { file: 'web/src/lib/time.ts', final: 'Math.round(words / 220)', steps: ['Math.round(words / 200)', 'Math.ceil(words / 250)'] },
  searchMin: { file: 'web/src/hooks/usePosts.ts', final: 'enabled: query.trim().length > 1,', steps: ['enabled: !!query,'] },
  pgHealth: { file: 'docker-compose.yml', final: 'interval: 5s', steps: ['interval: 10s', 'interval: 2s'] },
  nodeDeps: { file: 'Dockerfile', final: 'FROM node:20-alpine AS deps', steps: ['FROM node:18-alpine AS deps'] },
  nodeRun: { file: 'Dockerfile', final: 'FROM node:20-alpine\nWORKDIR /app\nENV', steps: ['FROM node:18-alpine\nWORKDIR /app\nENV'] },
  blurb: { file: 'src/render.js', final: 'truncate(post.body, 140)', steps: ['truncate(post.body, 100)'] },
  digestSubject: { file: 'src/notifications.js', final: '`Your weekly Inkwell digest`', steps: ["'Weekly digest'"] },
  roles: {
    file: 'src/auth/middleware.js',
    final: 'const ROLE_RANK = { reader: 0, author: 1, editor: 2, admin: 3 };',
    steps: ['const ROLE_RANK = { reader: 0, author: 1, admin: 2 };'],
  },
  bodyLength: { file: 'src/validate.js', final: 'post.body.length > 10;', steps: ['post.body.length > 0;'] },
  readmeMailer: { file: 'README.md', final: 'services/mailer Go worker that sends queued email', steps: ['services/mailer email worker'] },
  mailHeader: {
    file: 'services/mailer/internal/mail/sender.go',
    final: 'return strings.NewReplacer("\\r", " ", "\\n", " ").Replace(value)',
    steps: ['return value'],
  },
};

/* --------------------------------------------------------------- history */

// d: days ago. by: author. add: files or folder prefixes first committed here.
// edits: EDITS moved one version on. Special steps: branch, checkout, merge,
// backup, amend, reset, stash, cherryPick, event.
const PLAN = [
  { d: 221, by: 'ada', msg: 'feature: initial blog engine', add: ['package.json', '.gitignore', 'README.md', 'src/format.js', 'src/render.js', 'src/store.js', 'src/validate.js', 'src/api.js', 'src/app.js', 'src/utils/deprecated.js'] },
  { d: 214, by: 'ada', msg: 'test: cover format, render and validate', add: ['test/format.test.js', 'test/render.test.js', 'test/validate.test.js'] },
  { d: 206, by: 'priya', msg: 'feature(audit): audit trail on every mutation', add: ['src/audit.js'] },
  { d: 199, by: 'sam', msg: 'feature(export): legacy csv export', add: ['src/legacy.js'] },
  { d: 191, by: 'sam', msg: 'feature(telemetry): trace events across modules', add: ['src/telemetry.js'] },
  { d: 183, by: 'jonah', msg: 'feature(search): title search with ranking', add: ['src/search.js'] },
  { d: 171, by: 'priya', msg: 'security(auth): pbkdf2 password hashing', add: ['src/auth/password.js'] },
  { d: 166, by: 'priya', msg: 'feature(auth): sessions and role middleware', add: ['src/auth/session.js', 'src/auth/middleware.js', 'src/cache.js'] },
  { d: 161, by: 'priya', msg: 'test(auth): password hashing', add: ['test/auth/'] },
  { d: 151, by: 'mina', msg: 'chore(docker): containerise the api', add: ['Dockerfile', '.dockerignore'] },
  { d: 146, by: 'mina', msg: 'feature(db): postgres schema and repositories', add: ['db/migrations/001_users_posts.sql', 'src/db/', 'src/config.js'] },
  { d: 141, by: 'ada', msg: 'refactor(export): widen legacy rows', edits: ['legacyWidth'] },
  { d: 133, by: 'sam', msg: 'perf(telemetry): skip debug events', edits: ['emitRule'] },
  { d: 129, by: 'priya', msg: 'feature(db): sessions and tags tables', add: ['db/migrations/003_sessions_tags.sql', 'src/tags.js'] },
  { d: 121, by: 'sam', msg: 'bug fix(telemetry): bracket event names', edits: ['eventFormat'] },
  { d: 116, by: 'jonah', msg: 'refactor(search): weight title matches higher', edits: ['titleWeight'] },
  { d: 111, by: 'mina', msg: 'feature(docker): compose stack with postgres, redis and mongo', add: ['docker-compose.yml', 'nginx/'] },
  { d: 105, by: 'ada', msg: 'feature(admin): daily report and csv export', add: ['src/admin/', 'prisma/'] },
  { d: 101, by: 'priya', msg: 'feature(audit): mongo audit event model', add: ['src/models/auditEvent.model.js'], edits: ['auditEntry'] },

  // A PR from Leo and Jonah, merged on GitHub.
  { branch: 'feature/comments', d: 87, by: 'leo' },
  { d: 87, by: 'leo', msg: 'feature(comments): threaded comments api', add: ['src/comments.js', 'src/notifications.js', 'db/migrations/002_comments.sql'] },
  { d: 85, by: 'jonah', msg: 'feature(comments): spam filter', edits: ['blockedWords', 'spamLinks'] },
  { d: 83, by: 'leoWeb', msg: 'test(comments): threading, spam and cache', add: ['test/comments.test.js', 'test/cache.test.js'] },
  { d: 82, by: 'leoWeb', msg: 'feature(comments): notify followers', add: ['src/models/notification.model.js'], edits: ['digestSubject'] },
  { checkout: 'main', d: 81, by: 'leoWeb' },
  { merge: 'feature/comments', d: 81, by: 'leoWeb', committer: 'github', msg: 'Merge pull request #12 from leopark/feature/comments\n\nThreaded comments' },

  { event: { kind: 'enabled' }, d: 80, by: 'ada' },
  { backup: 'manual', note: 'backups enabled', d: 80, by: 'ada' },
  { d: 79, by: 'leo', msg: 'feature(web): react frontend with post list', add: ['web/package.json', 'web/src/main.tsx', 'web/src/App.tsx', 'web/src/api/', 'web/src/lib/', 'web/src/hooks/', 'web/src/components/PostCard.tsx', 'web/src/components/PostList.tsx', 'web/src/components/TagList.tsx', 'web/src/components/LegacyBanner.tsx'] },
  { d: 75, by: 'leo', msg: 'feature(web): comment thread and sign in', add: ['web/src/components/CommentThread.tsx', 'web/src/components/Navbar.tsx'] },
  { event: { kind: 'terminal', command: 'docker compose up --build', exitCode: 0 }, d: 73, by: 'mina' },
  { d: 73, by: 'mina', msg: 'chore(docker): web image behind nginx', add: ['web/Dockerfile'] },
  { d: 71, by: 'sam', msg: 'bug fix(export): row width overflow', edits: ['legacyWidth'], backupBefore: true },
  { d: 67, by: 'priya', msg: 'security(auth): httponly session cookie', edits: ['cookieFlags'] },
  { d: 63, by: 'priya', msg: 'security(auth): secure and samesite cookie flags', edits: ['cookieFlags'] },
  { d: 62, by: 'sam', msg: 'perf(telemetry): drop short event names', edits: ['emitRule'] },
  { d: 60, by: 'ada', msg: 'fix cache', edits: ['cacheHit'] },
  { amend: 'bug fix(cache): cached falsy values were recomputed', d: 60, by: 'ada' },

  // Mina's mailer, merged locally.
  { branch: 'feature/mailer', d: 59, by: 'mina' },
  { d: 59, by: 'mina', msg: 'feature(mailer): go worker for queued email', add: ['services/mailer/main.go', 'services/mailer/go.mod', 'services/mailer/Dockerfile', 'services/mailer/internal/queue/', 'services/mailer/internal/mail/sender.go', 'services/mailer/internal/mail/templates.go'] },
  { d: 56, by: 'mina', msg: 'test(mailer): template rendering', add: ['services/mailer/internal/mail/templates_test.go'] },
  { d: 55, by: 'mina', msg: 'feature(mailer): retry failed deliveries', edits: ['mailRetries'] },
  { checkout: 'main', d: 54, by: 'ada' },
  { merge: 'feature/mailer', d: 54, by: 'ada', msg: "Merge branch 'feature/mailer'" },

  { d: 51, by: 'sam', msg: 'refactor(export): configurable export width', edits: ['exportWidth'] },
  { d: 48, by: 'priya', msg: 'security(auth): raise pbkdf2 iterations', edits: ['pbkdf2'] },
  { d: 46, by: 'jonah', msg: 'feature(rss): rss feed', add: ['src/feed/', 'test/rss.test.js'] },
  { d: 43, by: 'leo', msg: 'bug fix(web): search only after two characters', edits: ['searchMin'] },
  { d: 41, by: 'sam', msg: 'tune trace emit rules', edits: ['emitRule'] },
  { event: { kind: 'terminal', command: 'npm test', exitCode: 1 }, d: 39, by: 'mina' },
  { d: 38, by: 'mina', msg: 'feature(rate-limit): token bucket per client', add: ['src/rateLimit.js'] },
  { d: 37, by: 'mina', msg: 'docs(mailer): describe the mailer service', edits: ['readmeMailer'] },
  { d: 36, by: 'priya', msg: 'feature(auth)!: editor role between author and admin', edits: ['roles'] },
  { d: 34, by: 'sam', msg: 'bug fix(export): long titles broke csv rows', edits: ['legacyWidth'], backupBefore: true },
  { d: 32, by: 'ada', msg: 'feature: api server entrypoint', add: ['src/server.js'] },

  // Hotfix on main, cherry-picked onto the release branch.
  { createBranch: 'release/2.2', d: 30, by: 'mina' },
  { d: 30, by: 'mina', msg: 'hotfix(rate-limit): capacity too low for feed readers', edits: ['bucketCapacity'] },
  { checkout: 'release/2.2', d: 30, by: 'mina' },
  { cherryPick: 'main', d: 30, by: 'mina' },
  { checkout: 'main', d: 30, by: 'mina' },
  { event: { kind: 'terminal', command: 'git push origin release/2.2', exitCode: 0 }, d: 30, by: 'mina' },
  { event: { kind: 'push-guard', remote: 'origin', others: 1, status: 0 }, d: 30, by: 'mina' },

  { d: 28, by: 'sam', msg: 'rework trace emit path', edits: ['eventFormat'] },
  { reset: 'wip: inline the trace sink', d: 27, by: 'sam' },
  { d: 26, by: 'jonah', msg: 'bug fix(rss): newest posts first', edits: ['rssOrder'] },
  { d: 24, by: 'leo', msg: 'style(web): round reading time up', edits: ['readingTime'] },
  { d: 22, by: 'priya', msg: 'feature(audit): version audit entries', edits: ['auditEntry'] },
  { d: 20, by: 'mina', msg: 'chore(docker): pin node 20 and tune healthcheck', edits: ['nodeDeps', 'nodeRun', 'pgHealth'] },
  { d: 18, by: 'sam', msg: 'perf(rate-limit): lower capacity, faster refill', edits: ['bucketCapacity', 'bucketRefill'] },
  { backup: 'manual', note: 'before render refactor', d: 16, by: 'ada' },
  { d: 16, by: 'ada', msg: 'refactor(render): longer blurbs', edits: ['blurb'] },
  { d: 15, by: 'jonah', msg: 'bug fix(comments): stricter link spam threshold', edits: ['spamLinks'] },
  { d: 13, by: 'sam', msg: 'bug fix(export): width for the new templates', edits: ['legacyWidth'] },
  { d: 12, by: 'priya', msg: 'security(mailer): strip newlines from mail headers', edits: ['mailHeader'] },
  { stash: 'README.md', d: 11, by: 'ada' },
  { d: 10, by: 'ada', msg: 'bug fix(validate): reject near-empty bodies', edits: ['bodyLength'] },
  { d: 9, by: 'leoWeb', msg: 'feature(web): reading time on cards', edits: ['readingTime'] },
  { d: 8, by: 'sam', msg: 'perf(telemetry): event name length check', edits: ['emitRule'], backupBefore: true },
  { d: 6, by: 'priya', msg: 'bug fix(auth): session ttl back to three days', edits: ['sessionTtl'] },
  { d: 5, by: 'mina', msg: 'chore(docker): faster postgres healthcheck', edits: ['pgHealth'] },
  { d: 4, by: 'jonah', msg: 'refactor(comments): extend blocked word list', edits: ['blockedWords'] },
  { event: { kind: 'terminal', command: 'git reset --hard HEAD~1', exitCode: 0 }, d: 3, by: 'sam' },
  { d: 3, by: 'sam', msg: 'tune legacy row width', edits: ['legacyWidth'] },
  { d: 2, by: 'ada', msg: 'refactor(api): single not-found path', edits: ['notFound'] },
  { d: 1, by: 'ada', msg: 'test: refresh coverage report', add: ['coverage/'], finalize: true },
  { event: { kind: 'terminal', command: 'npm test -- --coverage', exitCode: 0 }, d: 1, by: 'ada' },
];

/* -------------------------------------------------------------- coverage */

// Share of each function's executable lines hit by the test run.
const COVERAGE = {
  'src/format.js': { slugify: 1, truncate: 1, titleCase: 1, escapeHtml: 1, stripTags: 1, pluralize: 1 },
  'src/render.js': { renderCard: 1, renderList: 1, renderFeed: 1, wrapFeed: 1, renderHero: 0, renderPage: 0, renderTagLine: 0 },
  'src/validate.js': { hasTitle: 1, hasBody: 1, isValidPost: 1, sanitizePost: 0, assertPost: 0 },
  'src/auth/password.js': { hashPassword: 1, parseHash: 1, verifyPassword: 1, needsRehash: 1, isStrongPassword: 1 },
  'src/comments.js': { createCommentStore: 1, isSpam: 1, addComment: 0.7, threadComments: 1, countReplies: 1, listComments: 0, moderateComment: 0 },
  'src/cache.js': { cacheKey: 1, cacheGet: 0.6, cacheSet: 1, cacheDelete: 0, invalidatePrefix: 1, withCache: 1 },
  'src/feed/rss.js': { escapeXml: 1, rssItem: 1, buildRss: 0 },
  'src/telemetry.js': { trace: 0, formatEvent: 0, shouldEmit: 0, sink: 0 },
  'src/audit.js': { recordChange: 0, trail: 0, recentChanges: 0 },
  'src/notifications.js': { follow: 0, queueEmail: 0, notifyFollowers: 0, formatDigestLine: 0, buildDigest: 0, drainOutbox: 0 },
  'web/src/lib/time.ts': { timeAgo: 0.85, readingTime: 1, formatDate: 0 },
};

/** 0-based [start, end] line range of a named function, found by its declaration and matching braces. */
function functionRange(lines, name) {
  const decl = new RegExp(`\\bfunction\\s+${name}\\s*[(<]|\\b(?:const|let|var)\\s+${name}\\s*=`);
  const start = lines.findIndex((l) => decl.test(l));
  if (start === -1) {
    throw new Error(`coverage: function ${name} not found`);
  }
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (opened && depth === 0) {
      return [start, i];
    }
  }
  throw new Error(`coverage: unbalanced braces in ${name}`);
}

function isExecutable(line) {
  const t = line.trim();
  return t !== '' && !t.startsWith('//') && !/^[}\])]+[;,)]*$/.test(t);
}

function buildLcov(files) {
  const out = ['TN:'];
  for (const [file, fns] of Object.entries(COVERAGE)) {
    const lines = files.get(file).split('\n');
    const hits = new Map();
    for (const [name, share] of Object.entries(fns)) {
      const [start, end] = functionRange(lines, name);
      const executable = [];
      for (let i = start; i <= end; i++) {
        if (isExecutable(lines[i])) {
          executable.push(i + 1);
        }
      }
      const covered = Math.round(executable.length * share);
      executable.forEach((lineNo, i) => hits.set(lineNo, i < covered ? 1 + ((lineNo * 7) % 5) : 0));
    }
    const sorted = [...hits.entries()].sort((a, b) => a[0] - b[0]);
    out.push(`SF:${file}`);
    for (const [lineNo, count] of sorted) {
      out.push(`DA:${lineNo},${count}`);
    }
    out.push(`LF:${sorted.length}`, `LH:${sorted.filter(([, c]) => c > 0).length}`, 'end_of_record');
  }
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------- run */

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, base));
    } else {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

function main() {
  if (fs.existsSync(path.join(demoDir, '.git')) && !force) {
    console.log('demo/ already has git history - run with --force to rebuild it.');
    return;
  }

  // Final contents, with a coverage report generated from them.
  const finalFiles = new Map(listFiles(demoDir).map((f) => [f, fs.readFileSync(path.join(demoDir, f), 'utf8')]));
  finalFiles.set('coverage/lcov.info', buildLcov(finalFiles));
  fs.mkdirSync(path.join(demoDir, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(demoDir, 'coverage', 'lcov.info'), finalFiles.get('coverage/lcov.info'));

  for (const [id, edit] of Object.entries(EDITS)) {
    const text = finalFiles.get(edit.file);
    if (text === undefined) {
      throw new Error(`edit ${id}: no file ${edit.file}`);
    }
    if (text.split(edit.final).length !== 2) {
      throw new Error(`edit ${id}: "${edit.final}" must appear exactly once in ${edit.file}`);
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blast-radius-demo-'));
  const repo = path.join(tmp, 'demo');
  fs.mkdirSync(repo);
  const now = Date.now();
  let clock = 0;

  let stepIndex = 0;
  const when = (step) => {
    // Spread steps through the working day (09:00-18:00), always moving forward.
    const day = new Date(now - step.d * 86400000);
    day.setUTCHours(9, 0, 0, 0);
    const minutes = (stepIndex++ * 173) % 540;
    const t = Math.max(day.getTime() + minutes * 60000, clock + 7 * 60000);
    clock = Math.min(t, now - 60000);
    return new Date(clock).toISOString();
  };


  const envFor = (step, date) => {
    const author = PEOPLE[step.by];
    const committer = PEOPLE[step.committer || step.by];
    return {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: date,
    };
  };

  const git = (args, env) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repo,
      env: env || process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  // Which version each edit is at; undefined until its file is committed.
  const version = {};
  const added = new Set();
  const named = new Set(PLAN.flatMap((s) => (s.add || []).filter((p) => !p.endsWith('/'))));

  const contentOf = (file) => {
    let text = finalFiles.get(file);
    for (const [id, edit] of Object.entries(EDITS)) {
      if (edit.file === file && version[id] < edit.steps.length) {
        text = text.replace(edit.final, () => edit.steps[version[id]]);
      }
    }
    return text;
  };

  const writeFile = (file) => {
    const full = path.join(repo, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contentOf(file));
  };

  const applyChanges = (step) => {
    const files = new Set();
    for (const entry of step.add || []) {
      const matches = entry.endsWith('/')
        ? [...finalFiles.keys()].filter((f) => f.startsWith(entry) && !added.has(f) && !named.has(f))
        : [entry];
      if (!matches.length) {
        throw new Error(`step "${step.msg}": nothing to add for ${entry}`);
      }
      for (const file of matches) {
        if (!finalFiles.has(file)) {
          throw new Error(`step "${step.msg}": no file ${file}`);
        }
        added.add(file);
        files.add(file);
        for (const [id, edit] of Object.entries(EDITS)) {
          if (edit.file === file && version[id] === undefined) {
            version[id] = 0;
          }
        }
      }
    }
    for (const id of step.edits || []) {
      if (version[id] === undefined) {
        throw new Error(`step "${step.msg}": edit ${id} before its file was added`);
      }
      if (version[id] >= EDITS[id].steps.length) {
        throw new Error(`step "${step.msg}": edit ${id} is already final`);
      }
      version[id]++;
      files.add(EDITS[id].file);
    }
    if (step.finalize) {
      for (const file of finalFiles.keys()) {
        if (!added.has(file)) {
          added.add(file);
          files.add(file);
        }
      }
      for (const [id, edit] of Object.entries(EDITS)) {
        if (version[id] !== edit.steps.length) {
          console.log(`note: ${id} was not stepped to its final text before the last commit`);
          version[id] = edit.steps.length;
          files.add(edit.file);
        }
      }
    }
    files.forEach(writeFile);
    return files;
  };

  const backup = (trigger, note, env) => {
    execFileSync('sh', [backupScript, trigger, note || ''], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  };

  const events = [];

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', PEOPLE.ada.name]);
  git(['config', 'user.email', PEOPLE.ada.email]);

  for (const step of PLAN) {
    const date = when(step);
    const env = envFor(step, date);
    const person = PEOPLE[step.by];

    if (step.branch) {
      git(['checkout', '-q', '-b', step.branch], env);
    } else if (step.createBranch) {
      git(['branch', step.createBranch], env);
    } else if (step.checkout) {
      git(['checkout', '-q', step.checkout], env);
    } else if (step.merge) {
      git(['merge', '--no-ff', '-q', '-m', step.msg, step.merge], env);
      git(['branch', '-d', step.merge], env);
    } else if (step.cherryPick) {
      git(['cherry-pick', '-x', step.cherryPick], env);
    } else if (step.amend) {
      git(['commit', '-q', '--amend', '-m', step.amend], env);
    } else if (step.reset) {
      fs.writeFileSync(path.join(repo, 'src', 'trace-sink.js'), 'module.exports = [];\n');
      git(['add', 'src/trace-sink.js'], env);
      git(['commit', '-q', '-m', step.reset], env);
      git(['reset', '-q', '--hard', 'HEAD~1'], env);
    } else if (step.stash) {
      const full = path.join(repo, step.stash);
      fs.appendFileSync(full, '\n## Deploying\n\nTODO: write this section.\n');
      git(['stash', 'push', '-q', '-m', 'half-written deploy docs', '--', step.stash], env);
    } else if (step.backup) {
      backup(step.backup, step.note, env);
    } else if (step.event) {
      events.push({ t: Date.parse(date), ...step.event, name: person.name, email: person.email, cwd: '/home/dev/inkwell' });
    } else if (step.msg) {
      const files = applyChanges(step);
      if (step.backupBefore) {
        backup('interval', '', env);
      }
      git(['add', '--', ...files], env);
      git(['commit', '-q', '-m', step.msg], env);
      if (step.backupBefore) {
        backup('commit', '', env);
      }
    }
  }

  // Tag the commits whose messages do not follow the convention, the way the
  // extension does after a commit, so the features view shows the shared log too.
  const { addToFeatureLog, formatFeatureLog } = require('../out/featureLog');
  const TAGS = {
    'tune trace emit rules': 'Telemetry tuning',
    'rework trace emit path': 'Telemetry tuning',
    'tune legacy row width': 'CSV export width',
  };
  let logged = [];
  const untagged = git(['log', '--no-merges', '--format=%h%x1f%s%x1f%an%x1f%aI', 'HEAD']).split('\n').filter(Boolean);
  for (const row of untagged.reverse()) {
    const [hash, subject, who, iso] = row.split(String.fromCharCode(31));
    const feature = TAGS[subject];
    if (feature) {
      logged = addToFeatureLog(logged, feature, { hash, date: iso.slice(0, 10), who, summary: subject },
        feature === 'Telemetry tuning' ? 'performance' : 'bug fix');
    }
  }
  if (logged.length) {
    const dir = path.join(repo, '.blastradius');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'FEATURES.md'), formatFeatureLog(logged));
    fs.mkdirSync(path.join(demoDir, '.blastradius'), { recursive: true });
    fs.writeFileSync(path.join(demoDir, '.blastradius', 'FEATURES.md'), formatFeatureLog(logged));
    const last = PLAN[PLAN.length - 1];
    const env = envFor({ by: 'ada' }, when({ d: 1 }));
    git(['add', '--', '.blastradius/FEATURES.md'], env);
    git(['commit', '-q', '-m', 'chore: record which feature the untagged commits belong to'], env);
    void last;
  }

  // The working tree must now be exactly demo/.
  const status = git(['status', '--porcelain']).trim();
  if (status) {
    throw new Error(`history does not end at the demo files:\n${status}`);
  }
  for (const [file, text] of finalFiles) {
    if (fs.readFileSync(path.join(repo, file), 'utf8') !== text) {
      throw new Error(`history does not end at the demo files: ${file} differs`);
    }
  }

  const gitDir = path.join(repo, '.git');
  fs.mkdirSync(path.join(gitDir, 'blastradius'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'blastradius', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const target = path.join(demoDir, '.git');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(gitDir, target, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  const summary = execFileSync('git', ['log', '--format=%an', 'HEAD'], { cwd: demoDir, encoding: 'utf8' }).trim().split('\n');
  const backups = execFileSync('git', ['rev-list', '--count', 'blastradiusbackups'], { cwd: demoDir, encoding: 'utf8' }).trim();
  console.log(`built demo/ history: ${summary.length} commits by ${new Set(summary).size} people, ${backups} backups`);
}

main();
