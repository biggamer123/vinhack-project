const mongoose = require('mongoose');

const AuditEventSchema = new mongoose.Schema({
  actor: { type: String, required: true },
  action: { type: String, required: true },
  target: { type: String, required: true },
  ip: { type: String },
  metadata: { type: Object },
  at: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('audit_events', AuditEventSchema);
