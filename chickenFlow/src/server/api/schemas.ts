import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas for every inbound payload the backend accepts — both HTTP
// request bodies (validated via ../middleware/validate.js) and MQTT messages
// (validated directly in mqtt-bridge.service.ts). Request-shaped types are
// derived with z.infer instead of hand-written interfaces so validation and
// typing can never drift apart.
// ─────────────────────────────────────────────────────────────────────────────

// ── Door command — POST /api/door/command ────────────────────────────────────
export const doorCommandSchema = z.object({
  command: z.enum(['OPEN', 'CLOSE']),
  trigger: z.string().optional(),
});
export type DoorCommandBody = z.infer<typeof doorCommandSchema>;

// ── Settings patch — PUT /api/settings ───────────────────────────────────────
export const settingsPatchSchema = z.object({
  totalChickens: z.number().int().min(1).max(500).optional(),
  serviceMode: z.boolean().optional(),
  automaticDoor: z.boolean().optional(),
  musicDuration: z.number().int().min(0).max(60).optional(),
  smartNightLight: z.boolean().optional(),
  locationLat: z.number().min(-90).max(90).optional(),
  locationLon: z.number().min(-180).max(180).optional(),
  lightThreshold: z.number().int().min(0).max(4095).optional(),
});
export type SettingsPatchBody = z.infer<typeof settingsPatchSchema>;

// ── Status message — POST /api/messages ──────────────────────────────────────
// id is server-generated (serial PK) and createdAt covers the timestamp —
// neither is accepted from the client.
export const statusMessageSchema = z.object({
  text: z.string(),
  isWarning: z.boolean().optional(),
  isError: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  category: z.string().optional(),
});
export type StatusMessageBody = z.infer<typeof statusMessageSchema>;

// ── Message pin toggle — PATCH /api/messages/:id/pin ─────────────────────────
export const pinMessageSchema = z.object({
  pin: z.boolean().optional(),
});
export type PinMessageBody = z.infer<typeof pinMessageSchema>;

// ── AI analyze — POST /api/ai/analyze ────────────────────────────────────────
// Telemetry is always assembled server-side; the client may only attach a
// short free-text note.
export const aiAnalyzeSchema = z.object({
  contextNote: z.string().max(500).optional(),
});
export type AiAnalyzeBody = z.infer<typeof aiAnalyzeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// MQTT payloads (docs/mqtt-schema.md). Unknown extra fields MUST be ignored
// per the contract, so every schema below uses .passthrough() rather than
// .strict() — forward compatibility with firmware fields the backend doesn't
// read yet.
// ─────────────────────────────────────────────────────────────────────────────

// ── coop/telemetry ───────────────────────────────────────────────────────────
export const mqttTelemetrySchema = z.object({
  temp: z.number().optional(),
  ma: z.number().optional(),
  v: z.number().optional(),
  rssi: z.number().optional(),
  uptime_s: z.number().optional(),
  lightLevel: z.number().optional(),
}).passthrough();
export type MqttTelemetryPayload = z.infer<typeof mqttTelemetrySchema>;

// ── coop/count ────────────────────────────────────────────────────────────────
export const mqttCountSchema = z.object({
  dir: z.enum(['IN', 'OUT']),
  ts: z.string().optional(),
}).passthrough();
export type MqttCountPayload = z.infer<typeof mqttCountSchema>;

// ── coop/door/status ─────────────────────────────────────────────────────────
export const mqttDoorStatusSchema = z.object({
  state: z.enum(['OPEN', 'CLOSED', 'OPENING', 'CLOSING', 'ERROR']),
  // Free-form audit label on the firmware side (docs list solar/manual/mqtt/
  // obstruction/boot as the known set) — kept as a plain string so a new
  // firmware-side value doesn't drop the whole door-status update.
  last_event: z.string().optional(),
  from_state: z.string().optional(),
  limit_top: z.boolean().optional(),
  limit_bot: z.boolean().optional(),
  ma_peak: z.number().optional(),
}).passthrough();
export type MqttDoorStatusPayload = z.infer<typeof mqttDoorStatusSchema>;
