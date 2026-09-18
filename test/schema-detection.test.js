const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {
        findFiles: async () => [],
        fs: { readFile: async () => Buffer.from('') },
      },
      window: {
        showInformationMessage: () => {},
        showErrorMessage: () => {},
        createWebviewPanel: () => ({
          webview: { html: '', onDidReceiveMessage: () => {}, postMessage: () => {} },
          onDidDispose: () => {},
          reveal: () => {},
          dispose: () => {},
        }),
      },
      Uri: { file: (p) => ({ fsPath: p }) },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { extractDatabaseSchemas } = require('../out/schema');

test('detects Mongoose schema fields with nested objects and refs', () => {
  const text = `
    const mongoose = require('mongoose');
    const userSchema = new mongoose.Schema({
      name: { type: String, required: true },
      email: String,
      age: Number,
      profile: { city: String, active: Boolean },
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    }, { collection: 'users' });
    const User = mongoose.model('User', userSchema);
  `;

  const schemas = extractDatabaseSchemas('mongo.js', text);
  assert.equal(schemas.length, 2);
  const user = schemas.find((s) => s.name === 'userSchema');
  assert.ok(user);
  assert.ok(user.fields.some((field) => field.name === 'name'));
  assert.ok(user.fields.some((field) => field.name === 'profile'));
  assert.ok(user.fields.some((field) => field.name === 'userId'));
});

test('detects schema fields defined via helper factories and generic Schema types', () => {
  const text = `
    import mongoose, { Schema, type Model } from "mongoose";
    const requiredStringField = () => ({ type: String, required: true });
    const indexedStringField = (required = false) => ({ type: String, ...(required ? { required: true } : {}), index: true });
    const enumStringField = (values, options) => ({ type: String, enum: values, ...(options?.required ? { required: true } : {}) });
    const booleanField = (defaultValue = false) => ({ type: Boolean, default: defaultValue });

    const paperSchema = new Schema<IPaper>({
      thumbnail_url: requiredStringField(),
      file_url: requiredStringField(),
      subject: indexedStringField(true),
      exam: enumStringField(PAPER_EXAM_OPTIONS, { required: true }),
      answer_key_included: booleanField(),
    });

    const adminSchema = new Schema<IAdminPaper>({
      file_url: requiredStringField(),
      thumbnail_url: { type: String, required: false },
      subject: indexedStringField(),
      ambiguous_tags: { type: [String], default: [] },
    });
  `;

  const schemas = extractDatabaseSchemas('paper.ts', text);
  const paper = schemas.find((s) => s.name === 'paperSchema');
  const admin = schemas.find((s) => s.name === 'adminSchema');

  assert.ok(paper);
  assert.ok(admin);
  assert.ok(paper.fields.some((field) => field.name === 'thumbnail_url'));
  assert.ok(paper.fields.some((field) => field.name === 'exam'));
  assert.ok(paper.fields.some((field) => field.name === 'answer_key_included'));
  assert.ok(admin.fields.some((field) => field.name === 'ambiguous_tags'));
});
