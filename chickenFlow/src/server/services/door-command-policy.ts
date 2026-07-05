import type { DoorState } from '../api/types.js';

// Pure decision core for the door command path. The door-state service is a
// thin DB/MQTT shell around these functions so the rules are unit-testable
// without mocking drizzle or the broker.

export type DoorCommandAction = 'OPEN' | 'CLOSE';

// Last command we published that the device has not yet confirmed via
// coop/door/status. Expires so a dark device cannot latch commands forever
// (the pendingCommand column failure mode this replaces).
export interface InFlightCommand {
  action: DoorCommandAction;
  expiresAt: number; // epoch ms
}

export interface CommandDecision {
  publish: boolean;
  reason:
    | 'ok'
    | 'already-in-state'
    | 'already-moving'
    | 'command-in-flight';
}

// travel_ms_watchdog on the device is 15 s; give the full round trip
// (command → motor travel → status publish) a generous margin before we
// allow a re-send.
export const COMMAND_IN_FLIGHT_MS = 60_000;

const SETTLED_FOR: Record<DoorCommandAction, DoorState> = {
  OPEN: 'OPEN',
  CLOSE: 'CLOSED',
};

const MOVING_FOR: Record<DoorCommandAction, DoorState> = {
  OPEN: 'OPENING',
  CLOSE: 'CLOSING',
};

// currentState 'UNKNOWN' (no door_events yet — fresh install, bench device)
// and 'ERROR' both allow commands: UNKNOWN because we have nothing to compare
// against, ERROR because a commanded move is the recovery path.
export function decideCommand(
  action: DoorCommandAction,
  currentState: DoorState | 'UNKNOWN',
  inFlight: InFlightCommand | null,
  now: number = Date.now(),
): CommandDecision {
  if (inFlight && inFlight.expiresAt > now) {
    return { publish: false, reason: 'command-in-flight' };
  }
  if (currentState === SETTLED_FOR[action]) {
    return { publish: false, reason: 'already-in-state' };
  }
  if (currentState === MOVING_FOR[action]) {
    return { publish: false, reason: 'already-moving' };
  }
  return { publish: true, reason: 'ok' };
}

// door_events is an append-only transition log: recording the same settled
// state twice (device re-publishes retained status on reconnect) would fake
// a transition that never happened.
export function shouldRecordTransition(
  lastToState: string | null,
  nextToState: string,
): boolean {
  return lastToState !== nextToState;
}
