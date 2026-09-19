const { trace } = require('./telemetry');
const { pluralize } = require('./format');

const outbox = [];
const followers = new Map();

function follow(postId, userEmail) {
  followers.set(postId, [...new Set([...(followers.get(postId) || []), userEmail])]);
}

function queueEmail(to, subject, body) {
  trace('mail.queue', { to });
  const job = { to, subject, body, queuedAt: Date.now(), attempts: 0 };
  outbox.push(job);
  return job;
}

function notifyFollowers(postId, message) {
  trace('notify.followers', { postId });
  const emails = followers.get(postId) || [];
  return emails.map((email) => queueEmail(email, 'New activity on a post you follow', message));
}

function formatDigestLine(item) {
  return `- ${item.title} (${item.comments} ${pluralize('comment', item.comments)})`;
}

function buildDigest(user, items) {
  trace('notify.digest', { user: user.id });
  if (!items.length) {
    return null;
  }
  const lines = items.map(formatDigestLine);
  return queueEmail(user.email, `Your weekly Inkwell digest`, lines.join('\n'));
}

function drainOutbox(limit) {
  return outbox.splice(0, limit || outbox.length);
}

module.exports = { follow, queueEmail, notifyFollowers, buildDigest, formatDigestLine, drainOutbox };
