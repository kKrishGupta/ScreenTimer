// Shared event contracts for DigitalPulse collectors and the backend.
// JSON Schemas are the single source of truth; Rust (dp-core) and the
// browser extension mirror these definitions and are checked by tests.
import { readFileSync } from 'node:fs';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./schemas/${name}`, import.meta.url), 'utf8'));

export const activityEventSchema = load('activity-event.v1.schema.json');
export const activityBatchSchema = load('activity-batch.v1.schema.json');

export const SCHEMA_VERSION = 1;

export const EVENT_SOURCES = Object.freeze(['desktop_agent', 'browser_extension']);
export const EVENT_TYPES = Object.freeze(['app_session', 'web_session', 'idle_session']);
export const BROWSERS = Object.freeze(['chrome', 'edge']);

export const MAX_BATCH_SIZE = activityBatchSchema.properties.events.maxItems;
export const MAX_EVENT_DURATION_SECONDS = activityEventSchema.properties.durationSeconds.maximum;

