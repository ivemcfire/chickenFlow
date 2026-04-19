export const COOP_TZ = process.env['COOP_TZ'] ?? 'Europe/Sofia';

// 'en-CA' locale emits exactly YYYY-MM-DD without any padding or reordering.
export function localDate(instant: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: COOP_TZ }).format(instant);
}

// Returns the current UTC offset of `tz` in minutes (positive = east of UTC).
// DST-aware: derived from the actual instant, so Europe/Sofia returns 120 in
// winter (EET) and 180 in summer (EEST) with no hardcoded table.
export function tzOffsetMinutes(tz: string = COOP_TZ, instant: Date = new Date()): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(instant).reduce<Record<string, string>>(
    (acc, p) => { if (p.type !== 'literal') acc[p.type] = p.value; return acc; },
    {},
  );
  const asUTC = Date.UTC(
    +parts['year']!, +parts['month']! - 1, +parts['day']!,
    +parts['hour']!, +parts['minute']!, +parts['second']!,
  );
  return Math.round((asUTC - instant.getTime()) / 60000);
}
