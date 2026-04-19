import { tzOffsetMinutes, localDate } from './local-date';

describe('tzOffsetMinutes', () => {
  it('returns 180 for Europe/Sofia in summer (EEST)', () => {
    expect(tzOffsetMinutes('Europe/Sofia', new Date('2026-07-15T12:00:00Z'))).toBe(180);
  });

  it('returns 120 for Europe/Sofia in winter (EET)', () => {
    expect(tzOffsetMinutes('Europe/Sofia', new Date('2026-01-15T12:00:00Z'))).toBe(120);
  });
});

describe('localDate', () => {
  it('returns Sofia-local date for 2026-04-19T01:30:00Z (UTC+3 in summer)', () => {
    expect(localDate(new Date('2026-04-19T01:30:00Z'))).toBe('2026-04-19');
  });
});
