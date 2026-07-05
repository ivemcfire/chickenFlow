import type { SettingsPatchBody } from './schemas.js';

// Converts a partial settings payload into a database patch containing ONLY
// the keys that were actually provided. This prevents a partial PUT from
// silently resetting untouched fields to their schema defaults.
export function buildSettingsPatch(
  body: SettingsPatchBody,
  now: Date = new Date(),
): Record<string, unknown> {
  const patch: Record<string, unknown> = { updatedAt: now };
  if (body.totalChickens !== undefined) patch['totalChickens'] = body.totalChickens;
  if (body.serviceMode !== undefined) patch['serviceMode'] = body.serviceMode;
  if (body.automaticDoor !== undefined) patch['automaticDoor'] = body.automaticDoor;
  if (body.musicDuration !== undefined) patch['musicDuration'] = body.musicDuration;
  if (body.smartNightLight !== undefined) patch['smartNightLight'] = body.smartNightLight;
  if (body.locationLat !== undefined) patch['locationLat'] = body.locationLat;
  if (body.locationLon !== undefined) patch['locationLon'] = body.locationLon;
  if (body.lightThreshold !== undefined) patch['lightThreshold'] = body.lightThreshold;
  return patch;
}
