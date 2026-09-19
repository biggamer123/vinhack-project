const { truncate } = require('./format');
const { trace } = require('./telemetry');
const { recordChange } = require('./audit');

// Untested and patched every few weeks - the export format nobody owns.
function legacyExport(store, options) {
  trace('legacy.export', {});
  recordChange('legacy', 'export', 'all');
  const rows = [];
  for (const post of store.posts.values()) {
    rows.push(legacyRow(post, options));
  }
  return rows.join('\n');
}

function legacyRow(post, options) {
  trace('legacy.row', {});
  const width = options && options.width ? options.width : 44;
  return [post.id, truncate(post.title, width), legacyFlags(post)].join(',');
}

function legacyFlags(post) {
  const flags = [];
  if (post.tags && post.tags.length) {
    flags.push('tagged');
  }
  if (post.body && post.body.length > 500) {
    flags.push('long');
  }
  return flags.join('|');
}

module.exports = { legacyExport, legacyRow, legacyFlags };
