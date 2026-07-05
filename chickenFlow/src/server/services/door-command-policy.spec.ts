import { describe, it, expect } from 'vitest';
import {
  decideCommand,
  shouldRecordTransition,
  COMMAND_IN_FLIGHT_MS,
  type InFlightCommand,
} from './door-command-policy';

const NOW = 1_750_000_000_000;

describe('decideCommand', () => {
  it('publishes OPEN when door is CLOSED and nothing is in flight', () => {
    expect(decideCommand('OPEN', 'CLOSED', null, NOW)).toEqual({
      publish: true,
      reason: 'ok',
    });
  });

  it('publishes CLOSE when door is OPEN and nothing is in flight', () => {
    expect(decideCommand('CLOSE', 'OPEN', null, NOW)).toEqual({
      publish: true,
      reason: 'ok',
    });
  });

  it('skips when door is already in the settled target state', () => {
    expect(decideCommand('OPEN', 'OPEN', null, NOW).reason).toBe('already-in-state');
    expect(decideCommand('CLOSE', 'CLOSED', null, NOW).reason).toBe('already-in-state');
  });

  it('skips when door is already moving toward the target', () => {
    expect(decideCommand('OPEN', 'OPENING', null, NOW).reason).toBe('already-moving');
    expect(decideCommand('CLOSE', 'CLOSING', null, NOW).reason).toBe('already-moving');
  });

  it('allows reversing an in-progress movement', () => {
    // CLOSING + OPEN command = the keeper changed their mind mid-travel.
    expect(decideCommand('OPEN', 'CLOSING', null, NOW).publish).toBe(true);
    expect(decideCommand('CLOSE', 'OPENING', null, NOW).publish).toBe(true);
  });

  it('allows commands from UNKNOWN (no door_events yet)', () => {
    expect(decideCommand('OPEN', 'UNKNOWN', null, NOW).publish).toBe(true);
    expect(decideCommand('CLOSE', 'UNKNOWN', null, NOW).publish).toBe(true);
  });

  it('allows commands from ERROR (commanded move is the recovery path)', () => {
    expect(decideCommand('OPEN', 'ERROR', null, NOW).publish).toBe(true);
    expect(decideCommand('CLOSE', 'ERROR', null, NOW).publish).toBe(true);
  });

  it('blocks while a command is in flight', () => {
    const inFlight: InFlightCommand = { action: 'OPEN', expiresAt: NOW + 1 };
    expect(decideCommand('CLOSE', 'CLOSED', inFlight, NOW).reason).toBe('command-in-flight');
  });

  it('blocks a duplicate of the in-flight command', () => {
    const inFlight: InFlightCommand = {
      action: 'OPEN',
      expiresAt: NOW + COMMAND_IN_FLIGHT_MS,
    };
    expect(decideCommand('OPEN', 'CLOSED', inFlight, NOW).reason).toBe('command-in-flight');
  });

  it('allows a new command once the in-flight entry has expired', () => {
    // This is the regression test for the stuck-pendingCommand failure mode:
    // a command the device never confirms must not block automation forever.
    const inFlight: InFlightCommand = { action: 'OPEN', expiresAt: NOW };
    expect(decideCommand('OPEN', 'CLOSED', inFlight, NOW).publish).toBe(true);
  });
});

describe('shouldRecordTransition', () => {
  it('records a genuine state change', () => {
    expect(shouldRecordTransition('CLOSED', 'OPENING')).toBe(true);
  });

  it('records the first event when the log is empty', () => {
    expect(shouldRecordTransition(null, 'CLOSED')).toBe(true);
  });

  it('drops a duplicate settled state (retained status replay)', () => {
    expect(shouldRecordTransition('OPEN', 'OPEN')).toBe(false);
  });
});
