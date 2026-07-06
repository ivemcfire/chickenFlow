import { Injectable, signal, effect, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CoopStore, DoorState } from './coop-store.service';

// ─────────────────────────────────────────────────────────────────────────────
// CoopAnimationService — purely visual chicken-sprite movement for the coop
// viewport. It reads the store's real doorState/chickensInside/totalChickens
// to decide how many sprites should look "inside" vs "outside" and whether
// they can wander through the doorway, but it never writes to the store and
// never calls the API — all state here is cosmetic flourish, not truth.
// ─────────────────────────────────────────────────────────────────────────────

export interface Chicken {
  id: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  isInside: boolean;
  type: 'chick';
}

const CHICKEN_RADIUS = 16;
const FRAME_X_LEFT = 158;
const FRAME_X_RIGHT = 188;
const BUFFER = 24;
const SAFE_X_MIN = FRAME_X_LEFT - BUFFER;
const SAFE_X_MAX = FRAME_X_RIGHT + BUFFER;
const DOOR_Y_MIN = 70;
const DOOR_Y_MAX = 134;
/** Matches the door frame's x position — the coop/yard boundary for spawn placement. */
const COOP_DOOR_X = 168;

@Injectable({ providedIn: 'root' })
export class CoopAnimationService {
  private store = inject(CoopStore);
  private platformId = inject(PLATFORM_ID);

  readonly chickens = signal<Chicken[]>([]);
  readonly isReturning = signal<boolean>(false);

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return; // SSR guard

    this.resize(this.store.totalChickens());
    setInterval(() => this.tick(), 100);

    // Resize the flock whenever "Total Chickens" changes.
    effect(() => this.resize(this.store.totalChickens()));

    // Nudge the visual inside/outside split toward the real sensor count.
    // Cosmetic only — never written back to the store.
    effect(() => {
      const target = Math.max(0, Math.min(this.store.totalChickens(), this.store.chickensInside()));
      this.syncInsideCount(target);
    });
  }

  /** Visually resets every sprite to "inside" — used by the manual chicken-return control. */
  resetAllInside() {
    this.isReturning.set(true);
    this.chickens.update((prev) =>
      prev.map((c) => ({
        ...c,
        isInside: true,
        x: Math.random() * 100 + 40,
        y: Math.random() * 140 + 50,
        targetX: Math.random() * 100 + 40,
        targetY: Math.random() * 140 + 50,
      })),
    );
    setTimeout(() => this.isReturning.set(false), 3000);
  }

  private resize(count: number) {
    this.chickens.update((prev) => {
      if (count === prev.length) return prev;
      if (count < prev.length) return prev.slice(0, count);
      const next = [...prev];
      for (let i = prev.length; i < count; i++) {
        next.push(this.spawn(i));
      }
      return next;
    });
  }

  private spawn(id: number): Chicken {
    const x = Math.random() * 120 + 220; // spawn in the yard; the sync effect will pull some inside
    const y = Math.random() * 140 + 50;
    return { id, x, y, targetX: x, targetY: y, isInside: false, type: 'chick' };
  }

  private syncInsideCount(target: number) {
    const current = this.chickens();
    const insideCount = current.filter((c) => c.isInside).length;
    const diff = target - insideCount;
    if (diff === 0) return;

    const candidates = diff > 0
      ? current.map((c, i) => (!c.isInside ? i : -1)).filter((i) => i >= 0).slice(0, diff)
      : current.map((c, i) => (c.isInside ? i : -1)).filter((i) => i >= 0).slice(0, -diff);
    if (!candidates.length) return;

    const movingInside = diff > 0;
    this.chickens.update((prev) => {
      const next = prev.map((c) => ({ ...c }));
      for (const i of candidates) {
        const c = next[i];
        c.isInside = movingInside;
        c.targetX = movingInside ? Math.random() * 100 + 40 : Math.random() * 120 + 220;
        c.targetY = Math.random() * 140 + 50;
      }
      return next;
    });
  }

  private tick() {
    if (this.store.serviceMode()) return;

    const currentState = this.store.doorState();

    this.chickens.update((prev) => {
      const next = prev.map((c) => ({ ...c }));

      for (let i = 0; i < next.length; i++) {
        const c = next[i];

        if (Math.random() < 0.02) {
          if (currentState === DoorState.CLOSED || currentState === DoorState.ERROR) {
            if (c.x < COOP_DOOR_X) {
              c.targetX = Math.max(15, Math.min(SAFE_X_MIN - 5, c.targetX + (Math.random() - 0.5) * 75));
            } else {
              c.targetX = Math.max(SAFE_X_MAX + 5, Math.min(380, c.targetX + (Math.random() - 0.5) * 75));
            }
          } else {
            c.targetX = Math.max(15, Math.min(380, c.targetX + (Math.random() - 0.5) * 100));
            if (c.targetX > SAFE_X_MIN && c.targetX < SAFE_X_MAX) {
              if (Math.random() < 0.5) {
                c.targetX = c.x < COOP_DOOR_X ? SAFE_X_MIN - 10 : SAFE_X_MAX + 10;
              } else {
                c.targetY = 90;
              }
            }
          }
          c.targetY = Math.max(25, Math.min(165, c.targetY + (Math.random() - 0.5) * 100));
        }

        let moveX = (c.targetX - c.x) * 0.05;
        let moveY = (c.targetY - c.y) * 0.05;
        const nextX = c.x + moveX;
        const nextY = c.y + moveY;
        const inFrameX = nextX > SAFE_X_MIN && nextX < SAFE_X_MAX;
        const inOpeningY = nextY > DOOR_Y_MIN + 5 && nextY < DOOR_Y_MAX - 5;

        if (inFrameX) {
          if (currentState !== DoorState.OPEN || !inOpeningY) {
            moveX = 0;
            if (c.x > SAFE_X_MIN && c.x < SAFE_X_MAX) {
              moveX = c.x < COOP_DOOR_X ? -2 : 2;
            }
            if (currentState === DoorState.OPEN) {
              moveY = nextY < 90 ? 2 : -2;
            }
          }
        }

        c.x += moveX;
        c.y += moveY;

        for (let j = 0; j < next.length; j++) {
          if (i === j) continue;
          const other = next[j];
          const dx = c.x - other.x;
          const dy = c.y - other.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDistance = CHICKEN_RADIUS * 2;

          if (dist < minDistance) {
            const angle = Math.atan2(dy, dx);
            const overlap = minDistance - dist;
            const force = overlap * 0.5;
            c.x += Math.cos(angle) * force;
            c.y += Math.sin(angle) * force;
            other.x -= Math.cos(angle) * force;
            other.y -= Math.sin(angle) * force;
          }
        }
      }

      return next;
    });
  }
}
