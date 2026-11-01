import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  activityEventSchema,
  activityBatchSchema,
  EVENT_SOURCES,
  EVENT_TYPES,
  BROWSERS,
  MAX_BATCH_SIZE,
} from '../index.js';

const fixturesDir = new URL('../fixtures/', import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, fixturesDir), 'utf8'));

function compile() {
  const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  ajv.addSchema(activityEventSchema);
  return {
    validateEvent: ajv.getSchema(activityEventSchema.$id),
    validateBatch: ajv.compile(activityBatchSchema),
  };
}

const { validateEvent, validateBatch } = compile();
const validFiles = readdirSync(new URL('valid/', fixturesDir)).filter((f) => f.endsWith('.json'));

test('schemas compile in strict mode', () => {
  assert.equal(typeof validateEvent, 'function');
  assert.equal(typeof validateBatch, 'function');
});

for (const file of validFiles) {
  test(`valid fixture passes: ${file}`, () => {
    const event = readJson(`valid/${file}`);
    assert.ok(validateEvent(event), JSON.stringify(validateEvent.errors));
  });
}

for (const { reason, event } of readJson('invalid/events.json')) {
  test(`invalid fixture rejected: ${reason}`, () => {
    assert.equal(validateEvent(event), false);
  });
}

test('batch accepts valid events and enforces size limits', () => {
  const event = readJson('valid/idle-session.json');
  const device = {
    id: event.deviceId,
    kind: 'desktop_agent',
    name: 'DEV-PC',
    platform: 'windows',
  };
  assert.ok(validateBatch({ device, events: [event] }), JSON.stringify(validateBatch.errors));
  assert.equal(validateBatch({ device, events: [] }), false);
  const tooMany = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => event);
  assert.equal(validateBatch({ device, events: tooMany }), false);
});

test('exported enums match schema enums', () => {
  assert.deepEqual([...EVENT_SOURCES], activityEventSchema.properties.source.enum);
  assert.deepEqual([...EVENT_TYPES], activityEventSchema.properties.type.enum);
  assert.deepEqual([...BROWSERS], activityEventSchema.properties.web.properties.browser.enum);
});

