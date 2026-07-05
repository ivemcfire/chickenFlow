import { buildSettingsPatch } from './build-settings-patch';
import type { ApiSettings } from './types';

describe('buildSettingsPatch', () => {
  const fixedNow = new Date('2026-04-13T12:00:00Z');

  it('always includes updatedAt', () => {
    const patch = buildSettingsPatch({}, fixedNow);
    expect(patch).toEqual({ updatedAt: fixedNow });
  });

  it('includes only the keys present in the body (partial update)', () => {
    const patch = buildSettingsPatch({ serviceMode: true }, fixedNow);
    expect(patch).toEqual({ updatedAt: fixedNow, serviceMode: true });
    expect(patch['totalChickens']).toBeUndefined();
    expect(patch['locationLat']).toBeUndefined();
  });

  it('preserves falsy values like false and 0', () => {
    const patch = buildSettingsPatch(
      { automaticDoor: false, totalChickens: 0, locationLat: 0 },
      fixedNow,
    );
    expect(patch['automaticDoor']).toBe(false);
    expect(patch['totalChickens']).toBe(0);
    expect(patch['locationLat']).toBe(0);
  });

  it('passes through a full update unchanged', () => {
    const patch = buildSettingsPatch(
      {
        totalChickens: 12,
        serviceMode: false,
        automaticDoor: true,
        musicDuration: 7,
        smartNightLight: false,
        locationLat: 48.21,
        locationLon: 16.37,
      },
      fixedNow,
    );
    expect(patch).toEqual({
      updatedAt: fixedNow,
      totalChickens: 12,
      serviceMode: false,
      automaticDoor: true,
      musicDuration: 7,
      smartNightLight: false,
      locationLat: 48.21,
      locationLon: 16.37,
    });
  });

  it('ignores keys outside the ApiSettings patch surface', () => {
    const patch = buildSettingsPatch(
      { serviceMode: true, bogus: 'CLOSE' } as Partial<ApiSettings>,
      fixedNow,
    );
    expect(patch['bogus']).toBeUndefined();
  });
});
