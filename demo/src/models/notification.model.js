const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  postId: { type: String },
  kind: { type: String, enum: ['comment', 'mention', 'digest'], required: true },
  message: { type: String, required: true },
  readAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('notifications', NotificationSchema);
