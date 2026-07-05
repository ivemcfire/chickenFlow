import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { doorEvents, settings } from '../db/schema.js';
import { wsBroadcaster } from '../ws/ws-broadcaster.js';
import { publishDoorCommand } from './mqtt-bridge.service.js';
import {
  decideCommand,
  shouldRecordTransition,
  COMMAND_IN_FLIGHT_MS,
  type DoorCommandAction,
  type InFlightCommand,
} from './door-command-policy.js';
import type { DoorState } from '../api/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Single owner of door state.
//
// The device is the source of truth for physical state: the ONLY writer of
// door_events is recordDeviceTransition(), fed by coop/door/status. Everything
// that wants the door moved goes through requestDoorCommand(), which publishes
// coop/door/cmd — there is no command queue in the database.
// ─────────────────────────────────────────────────────────────────────────────

const MANUAL_OVERRIDE_MS = 15 * 60 * 1000;

let inFlight: InFlightCommand | null = null;

export async function getDoorState(): Promise<DoorState | 'UNKNOWN'> {
  const [latest] = await db
    .select({ toState: doorEvents.toState })
    .from(doorEvents)
    .orderBy(desc(doorEvents.createdAt))
    .limit(1);
  return (latest?.toState as DoorState | undefined) ?? 'UNKNOWN';
}

export interface DeviceTransition {
  toState: string;
  fromState?: string;
  trigger?: string; // firmware last_event: solar | manual | mqtt | obstruction | boot
}

// Append a device-reported transition. Dedupes retained-status replays,
// broadcasts, settles the in-flight command, and maintains the manual-override
// window (physical 5 s button press arrives as last_event = "manual").
export async function recordDeviceTransition(t: DeviceTransition): Promise<boolean> {
  const current = await getDoorState();
  if (!shouldRecordTransition(current === 'UNKNOWN' ? null : current, t.toState)) {
    return false;
  }

  const trigger = t.trigger ?? 'esp32';

  await db.insert(doorEvents).values({
    fromState: t.fromState ?? current,
    toState: t.toState,
    trigger,
    isManual: trigger === 'manual',
  });

  // Any settled state means the device acted — the round trip is complete
  // whether or not it matches what we asked for.
  if (t.toState === 'OPEN' || t.toState === 'CLOSED' || t.toState === 'ERROR') {
    inFlight = null;
  }

  if (trigger === 'manual') {
    if (t.toState === 'OPEN' || t.toState === 'OPENING') {
      await setManualOverride(new Date(Date.now() + MANUAL_OVERRIDE_MS));
    } else if (t.toState === 'CLOSED' || t.toState === 'CLOSING') {
      await setManualOverride(null);
    }
  }

  wsBroadcaster.broadcast('door:state_changed', {
    fromState: t.fromState ?? current,
    toState: t.toState,
    trigger,
  });
  return true;
}

export interface CommandResult {
  sent: boolean;
  reason: 'ok' | 'already-in-state' | 'already-moving' | 'command-in-flight' | 'mqtt-disconnected';
}

// The one command path. UI, solar automation, and weather lockdown all land
// here; the decision rules live in door-command-policy.ts.
export async function requestDoorCommand(
  action: DoorCommandAction,
  trigger: string,
  opts: { force?: boolean; manualOverride?: boolean } = {},
): Promise<CommandResult> {
  const current = await getDoorState();
  const decision = decideCommand(action, current, inFlight);
  if (!decision.publish) {
    return { sent: false, reason: decision.reason as CommandResult['reason'] };
  }

  const published = publishDoorCommand(action, trigger, opts.force ?? false);
  if (!published) {
    return { sent: false, reason: 'mqtt-disconnected' };
  }

  inFlight = { action, expiresAt: Date.now() + COMMAND_IN_FLIGHT_MS };

  // UI-initiated commands mirror the physical button semantics: OPEN holds
  // the door against automation for 15 min, CLOSE hands control back.
  if (opts.manualOverride) {
    await setManualOverride(
      action === 'OPEN' ? new Date(Date.now() + MANUAL_OVERRIDE_MS) : null,
    );
  }

  wsBroadcaster.broadcast('door:command_received', { command: action, trigger });
  return { sent: true, reason: 'ok' };
}

async function setManualOverride(until: Date | null): Promise<void> {
  await db.update(settings).set({ manualOverrideUntil: until }).where(eq(settings.id, 1));
}

// Test seam: the latch is module state, specs need to reset it between cases.
export function resetInFlightForTest(): void {
  inFlight = null;
}
