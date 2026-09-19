const { recentChanges } = require('../audit');
const { listPosts } = require('../store');
const { popularTags } = require('../tags');
const { trace } = require('../telemetry');

function topAuthors(posts, limit) {
  const counts = new Map();
  for (const post of posts) {
    counts.set(post.authorId, (counts.get(post.authorId) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit || 5);
}

function dailyReport(store) {
  trace('admin.report.daily', {});
  const posts = listPosts(store);
  return {
    posts: posts.length,
    authors: topAuthors(posts),
    tags: popularTags(posts, 5),
    changes: recentChanges(50).length,
  };
}

function csvCell(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv(rows, columns) {
  const header = columns.map(csvCell).join(',');
  return [header, ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(','))].join('\n');
}

// Pre-2025 report layout. Replaced by dailyReport; kept "just in case".
function weeklyReportV1(store) {
  const posts = listPosts(store);
  return `posts=${posts.length};authors=${topAuthors(posts, 3).length}`;
}

module.exports = { dailyReport, topAuthors, exportCsv, csvCell, weeklyReportV1 };
