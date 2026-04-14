import { stripJsonFences } from './strip-json-fences';

describe('stripJsonFences', () => {
  it('returns plain JSON unchanged', () => {
    const raw = '{"anomaly":true,"message":"ok","threat_type":"predator"}';
    expect(stripJsonFences(raw)).toBe(raw);
    expect(() => JSON.parse(stripJsonFences(raw))).not.toThrow();
  });

  it('strips ```json fenced blocks', () => {
    const raw = '```json\n{"anomaly":false,"message":"clear","threat_type":null}\n```';
    const parsed = JSON.parse(stripJsonFences(raw)) as { anomaly: boolean };
    expect(parsed.anomaly).toBe(false);
  });

  it('strips bare ``` fenced blocks', () => {
    const raw = '```\n{"anomaly":true}\n```';
    expect(JSON.parse(stripJsonFences(raw))).toEqual({ anomaly: true });
  });

  it('handles surrounding whitespace', () => {
    const raw = '   \n  ```json\n{"x":1}\n```  \n';
    expect(JSON.parse(stripJsonFences(raw))).toEqual({ x: 1 });
  });

  it('leaves an inline ``` inside the JSON body alone when unfenced', () => {
    const raw = '{"message":"got ``` ticks"}';
    expect(JSON.parse(stripJsonFences(raw))).toEqual({ message: 'got ``` ticks' });
  });
});
