import { pgTable, text, integer, serial, boolean, doublePrecision, timestamp, index } from 'drizzle-orm/pg-core';

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
  // ESP32 command queue — read and reset to NONE on delivery
  pendingCommand: text('pending_command').notNull().default('NONE'),
  // Manual override expiry. When > now(), automation jobs skip their tick;
  // the solar job clears the field and queues CLOSE once it has lapsed.
  manualOverrideUntil: timestamp('manual_override_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── door_events ───────────────────────────────────────────────────────────────
// Immutable append-only log of every door state transition.
export const doorEvents = pgTable('door_events', {
  id: serial('id').primaryKey(),
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
]);

// ── sensor_readings ───────────────────────────────────────────────────────────
// Time-series from ESP32-S2 Mini. Pruned to 7 days by cleanup job.
export const sensorReadings = pgTable('sensor_readings', {
  id: serial('id').primaryKey(),
  // Legacy column — kept for migration compatibility, no longer populated
  distanceCm: doublePrecision('distance_cm'),
  topSensorTriggered: boolean('top_sensor_triggered').notNull().default(false),
  irTriggered: boolean('ir_triggered').notNull().default(false),
  irATriggered: boolean('ir_a_triggered').notNull().default(false),
  irBTriggered: boolean('ir_b_triggered').notNull().default(false),
  chickensInside: integer('chickens_inside').notNull(),
  totalChickens: integer('total_chickens').notNull(),
  doorState: text('door_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('sensor_readings_created_at_idx').on(t.createdAt),
]);

// ── status_messages ───────────────────────────────────────────────────────────
// Replaces localStorage statusMessages[]. Non-pinned pruned at 30 days.
export const statusMessages = pgTable('status_messages', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  timestamp: text('timestamp').notNull(),
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
  countConfirmed: boolean('count_confirmed'),
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
});

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
