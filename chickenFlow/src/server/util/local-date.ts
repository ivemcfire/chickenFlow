export const COOP_TZ = process.env['COOP_TZ'] ?? 'Europe/Sofia';

// 'en-CA' locale emits exactly YYYY-MM-DD without any padding or reordering.
export function localDate(instant: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: COOP_TZ }).format(instant);
}
