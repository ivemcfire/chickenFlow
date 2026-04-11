import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ── settings ─────────────────────────────────────────────────────────────────
// Single-row config. Always upsert with id = 1.
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey().default(1),
  totalChickens: integer('total_chickens').notNull().default(10),
  serviceMode: integer('service_mode', { mode: 'boolean' }).notNull().default(false),
  automaticDoor: integer('automatic_door', { mode: 'boolean' }).notNull().default(true),
  musicDuration: integer('music_duration').notNull().default(5),
  smartNightLight: integer('smart_night_light', { mode: 'boolean' }).notNull().default(true),
  locationLat: real('location_lat').notNull().default(51.5074),
  locationLon: real('location_lon').notNull().default(-0.1278),
  // ESP32 command queue — read and reset to NONE on delivery
  pendingCommand: text('pending_command').notNull().default('NONE'),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ── door_events ───────────────────────────────────────────────────────────────
// Immutable append-only log of every door state transition.
export const doorEvents = sqliteTable('door_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromState: text('from_state').notNull(),
  toState: text('to_state').notNull(),
  // 'manual' | 'solar' | 'weather' | 'smart' | 'herding' | 'obstruction' | 'esp32'
  trigger: text('trigger').notNull(),
  isManual: integer('is_manual', { mode: 'boolean' }).notNull().default(false),
  chickensInside: integer('chickens_inside'),
  totalChickens: integer('total_chickens'),
  obstructionDistance: real('obstruction_distance'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  index('door_events_created_at_idx').on(t.createdAt),
  index('door_events_to_state_idx').on(t.toState),
]);

// ── sensor_readings ───────────────────────────────────────────────────────────
// Time-series from ESP32-CAM. Pruned to 7 days by cleanup job.
export const sensorReadings = sqliteTable('sensor_readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  distanceCm: real('distance_cm').notNull(),
  irTriggered: integer('ir_triggered', { mode: 'boolean' }).notNull().default(false),
  chickensInside: integer('chickens_inside').notNull(),
  totalChickens: integer('total_chickens').notNull(),
  doorState: text('door_state').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  index('sensor_readings_created_at_idx').on(t.createdAt),
]);

// ── status_messages ───────────────────────────────────────────────────────────
// Replaces localStorage statusMessages[]. Non-pinned pruned at 30 days.
export const statusMessages = sqliteTable('status_messages', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  timestamp: text('timestamp').notNull(),
  isWarning: integer('is_warning', { mode: 'boolean' }).notNull().default(false),
  isError: integer('is_error', { mode: 'boolean' }).notNull().default(false),
  isPinned: integer('is_pinned', { mode: 'boolean' }).notNull().default(false),
  category: text('category'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  index('status_messages_created_at_idx').on(t.createdAt),
  index('status_messages_is_pinned_idx').on(t.isPinned),
  index('status_messages_category_idx').on(t.category),
]);

// ── weather_cache ─────────────────────────────────────────────────────────────
// One row per calendar date, upserted by weather-poll job.
export const weatherCache = sqliteTable('weather_cache', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  forecastDate: text('forecast_date').notNull().unique(),
  weatherCode: integer('weather_code').notNull(),
  tempMax: real('temp_max').notNull(),
  tempMin: real('temp_min').notNull(),
  sunrise: text('sunrise').notNull(),
  sunset: text('sunset').notNull(),
  isSevere: integer('is_severe', { mode: 'boolean' }).notNull().default(false),
  fetchedAt: text('fetched_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  index('weather_cache_forecast_date_idx').on(t.forecastDate),
]);

// ── ai_analysis_log ───────────────────────────────────────────────────────────
// Full audit trail of every Claude API call — success or failure.
export const aiAnalysisLog = sqliteTable('ai_analysis_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  model: text('model').notNull().default('claude-sonnet-4-6'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  hasImage: integer('has_image', { mode: 'boolean' }).notNull().default(false),
  // Telemetry snapshot
  doorState: text('door_state').notNull(),
  chickensInside: integer('chickens_inside').notNull(),
  totalChickens: integer('total_chickens').notNull(),
  weatherCode: integer('weather_code'),
  tempMax: real('temp_max'),
  weatherLock: integer('weather_lock', { mode: 'boolean' }).notNull().default(false),
  serviceMode: integer('service_mode', { mode: 'boolean' }).notNull().default(false),
  obstructionDistance: real('obstruction_distance'),
  contextNote: text('context_note'),
  // Response
  analysisText: text('analysis_text'),
  isWarning: integer('is_warning', { mode: 'boolean' }).notNull().default(false),
  // Vision-specific (null for telemetry-only calls)
  anomalyDetected: integer('anomaly_detected', { mode: 'boolean' }),
  threatType: text('threat_type'),
  countConfirmed: integer('count_confirmed', { mode: 'boolean' }),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  index('ai_log_created_at_idx').on(t.createdAt),
]);

// ── camera_captures ───────────────────────────────────────────────────────────
// ESP32-CAM image metadata. Non-anomaly pruned at 48h, anomaly at 30 days.
export const cameraCaptures = sqliteTable('camera_captures', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filePath: text('file_path').notNull(),
  fileSizeBytes: integer('file_size_bytes'),
  widthPx: integer('width_px'),
  heightPx: integer('height_px'),
  doorStateAtCapture: text('door_state_at_capture'),
  chickensInsideAtCapture: integer('chickens_inside_at_capture'),
  isAnomaly: integer('is_anomaly', { mode: 'boolean' }).notNull().default(false),
  // 'predator' | 'obstruction' | 'injury' | null
  threatType: text('threat_type'),
  aiAnalysisId: integer('ai_analysis_id'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => [
  index('camera_captures_created_at_idx').on(t.createdAt),
  index('camera_captures_is_anomaly_idx').on(t.isAnomaly),
]);
