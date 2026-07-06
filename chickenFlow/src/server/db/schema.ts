import { pgTable, text, integer, serial, boolean, doublePrecision, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// door_events.toState / fromState are deliberately plain `text` + CHECK
// below, not a Postgres/Drizzle pgEnum. A real PgEnumColumn narrows Drizzle's
// insert type to the literal value union, which breaks door-state.service.ts
// (recordDeviceTransition takes toState/fromState as plain `string` — WP1,
// out of scope here) at compile time. CHECK constraints give the same
// DB-level enforcement without that TS coupling, matching the existing
// `trigger` precedent of staying text for forward-compat/no-breakage.
// Values mirror the DoorState string union in ../api/types.ts — keep in
// lock-step ('OPEN' | 'CLOSED' | 'OPENING' | 'CLOSING' | 'ERROR').

// ── settings ─────────────────────────────────────────────────────────────────
// Single-row config. Always upsert with id = 1.
export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  totalChickens: integer('total_chickens').notNull().default(10),
  serviceMode: boolean('service_mode').notNull().default(false),
  automaticDoor: boolean('automatic_door').notNull().default(true),
  musicDuration: integer('music_duration').notNull().default(5),
  smartNightLight: boolean('smart_night_light').notNull().default(true),
  locationLat: doublePrecision('location_lat').notNull().default(51.5074),
  locationLon: doublePrecision('location_lon').notNull().default(-0.1278),
  lightThreshold: integer('light_threshold').notNull().default(2000),
  // Manual override expiry. When > now(), automation jobs skip their tick;
  // the solar job clears the field and commands CLOSE once it has lapsed.
  manualOverrideUntil: timestamp('manual_override_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── door_events ───────────────────────────────────────────────────────────────
// Immutable append-only log of every door state transition.
export const doorEvents = pgTable('door_events', {
  id: serial('id').primaryKey(),
  // fromState additionally accepts 'UNKNOWN' — door-state.service records that
  // sentinel when the log is empty (WP1).
  fromState: text('from_state').notNull(),
  toState: text('to_state').notNull(),
  // 'manual' | 'solar' | 'weather' | 'smart' | 'herding' | 'obstruction' | 'esp32'
  trigger: text('trigger').notNull(),
  isManual: boolean('is_manual').notNull().default(false),
  chickensInside: integer('chickens_inside'),
  totalChickens: integer('total_chickens'),
  obstructionDistance: doublePrecision('obstruction_distance'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('door_events_created_at_idx').on(t.createdAt),
  index('door_events_to_state_idx').on(t.toState),
  check('door_events_to_state_check', sql`${t.toState} IN ('OPEN','CLOSED','OPENING','CLOSING','ERROR')`),
  check('door_events_from_state_check', sql`${t.fromState} IN ('OPEN','CLOSED','OPENING','CLOSING','ERROR','UNKNOWN')`),
]);

// ── count_events ──────────────────────────────────────────────────────────────
// Append-only raw transit log. chicken_counts (below) stays the atomic daily
// rollup mqtt-bridge upserts on every coop/count message; this table keeps
// the individual event too, so per-event history survives past midnight
// rollover. 'source' defaults to 'beam' (the current IR-tunnel hardware);
// 'camera' is reserved for the planned camera-fusion counting feature.
export const countEvents = pgTable('count_events', {
  id: serial('id').primaryKey(),
  dir: text('dir').notNull(),
  source: text('source').notNull().default('beam'),
  // Device-reported timestamp; falls back to server now() if the device omits ts.
  eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('count_events_event_at_idx').on(t.eventAt),
  check('count_events_dir_check', sql`${t.dir} IN ('IN','OUT')`),
  check('count_events_source_check', sql`${t.source} IN ('beam','camera')`),
]);

// ── status_messages ───────────────────────────────────────────────────────────
// Replaces localStorage statusMessages[]. Non-pinned pruned at 30 days.
export const statusMessages = pgTable('status_messages', {
  id: serial('id').primaryKey(),
  text: text('text').notNull(),
  isWarning: boolean('is_warning').notNull().default(false),
  isError: boolean('is_error').notNull().default(false),
  isPinned: boolean('is_pinned').notNull().default(false),
  category: text('category'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('status_messages_created_at_idx').on(t.createdAt),
  index('status_messages_is_pinned_idx').on(t.isPinned),
  index('status_messages_category_idx').on(t.category),
]);

// ── weather_cache ─────────────────────────────────────────────────────────────
// One row per calendar date, upserted by weather-poll job.
export const weatherCache = pgTable('weather_cache', {
  id: serial('id').primaryKey(),
  forecastDate: text('forecast_date').notNull().unique(),
  weatherCode: integer('weather_code').notNull(),
  tempMax: doublePrecision('temp_max').notNull(),
  tempMin: doublePrecision('temp_min').notNull(),
  sunrise: text('sunrise').notNull(),
  sunset: text('sunset').notNull(),
  isSevere: boolean('is_severe').notNull().default(false),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('weather_cache_forecast_date_idx').on(t.forecastDate),
]);

// ── ai_analysis_log ───────────────────────────────────────────────────────────
// Full audit trail of every AI API call — success or failure.
export const aiAnalysisLog = pgTable('ai_analysis_log', {
  id: serial('id').primaryKey(),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  // Telemetry snapshot
  doorState: text('door_state').notNull(),
  chickensInside: integer('chickens_inside').notNull(),
  totalChickens: integer('total_chickens').notNull(),
  weatherCode: integer('weather_code'),
  tempMax: doublePrecision('temp_max'),
  weatherLock: boolean('weather_lock').notNull().default(false),
  serviceMode: boolean('service_mode').notNull().default(false),
  obstructionDistance: doublePrecision('obstruction_distance'),
  contextNote: text('context_note'),
  // Response
  analysisText: text('analysis_text'),
  isWarning: boolean('is_warning').notNull().default(false),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ai_log_created_at_idx').on(t.createdAt),
]);

// ── chicken_counts ────────────────────────────────────────────────────────────
// Daily tally driven by MQTT coop/count events. `date` is Europe/Sofia local
// YYYY-MM-DD (NOT UTC) so midnight rollover lines up with the coop's real day.
export const chickenCounts = pgTable('chicken_counts', {
  date: text('date').primaryKey(),
  totalIn: integer('total_in').notNull().default(0),
  totalOut: integer('total_out').notNull().default(0),
  netInside: integer('net_inside').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('chicken_counts_total_in_check', sql`${t.totalIn} >= 0`),
  check('chicken_counts_total_out_check', sql`${t.totalOut} >= 0`),
]);

// ── device_status ─────────────────────────────────────────────────────────────
// Heartbeat liveness + diagnostic snapshot, one row per device.
export const deviceStatus = pgTable('device_status', {
  deviceId: text('device_id').primaryKey(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  rssi: integer('rssi'),
  voltageV: doublePrecision('voltage_v'),
  currentMa: integer('current_ma'),
  tempC: doublePrecision('temp_c'),
  uptimeS: integer('uptime_s'),
  lightLevel: integer('light_level'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── camera_captures ───────────────────────────────────────────────────────────
// IP cam (cam01) snapshot metadata. Non-anomaly pruned at 48h, anomaly at 30 days.
export const cameraCaptures = pgTable('camera_captures', {
  id: serial('id').primaryKey(),
  filePath: text('file_path').notNull(),
  fileSizeBytes: integer('file_size_bytes'),
  widthPx: integer('width_px'),
  heightPx: integer('height_px'),
  doorStateAtCapture: text('door_state_at_capture'),
  chickensInsideAtCapture: integer('chickens_inside_at_capture'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('camera_captures_created_at_idx').on(t.createdAt),
]);
