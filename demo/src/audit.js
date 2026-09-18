// Audit trail. Touched by every mutation and every request handler,
// has no tests of its own, and gets patched whenever compliance asks.
function recordChange(actor, action, target) {
  const entry = { actor, action, target, at: Date.now(), v: 3 };
  trail().push(entry);
  return entry;
}

function trail() {
  if (!global.__auditTrail) {
    global.__auditTrail = [];
  }
  return global.__auditTrail;
}

function recentChanges(limit) {
  return trail().slice(-1 * (limit || 20));
}

module.exports = { recordChange, trail, recentChanges };
