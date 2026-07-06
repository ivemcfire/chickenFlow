import { Injectable, signal, computed, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ApiService, type ApiMessage } from './api.service';

// ─────────────────────────────────────────────────────────────────────────────
// MessagesService — the "AI Status Report" / system log.
//
// Persisted messages (status_messages rows) are backend-authoritative: this
// service hydrates GET /api/messages, then appends live from the
// system:message WS broadcast the backend fires on every POST /api/messages
// write (its own or another client's) rather than trusting its own optimistic
// copy — that's what keeps ids/timestamps server-assigned instead of
// client-guessed.
//
// system:alert events are different: the backend broadcasts them from cron
// jobs (ESP32 offline, weather lockdown, solar automation, LDR failsafe, …)
// but never persists them, so there is no row/id to hydrate later. Those are
// shown as local, ephemeral entries with a negative synthetic id — distinct
// on purpose from the real (positive, server-assigned) ids on persisted rows.
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusMessage {
  id: number;
  text: string;
  createdAt: string;
  isWarning: boolean;
  isError: boolean;
  isPinned: boolean;
  category?: string | null;
}

export interface PostMessageOptions {
  isWarning?: boolean;
  isError?: boolean;
  isPinned?: boolean;
  category?: string;
}

@Injectable({ providedIn: 'root' })
export class MessagesService {
  private api = inject(ApiService);
  private platformId = inject(PLATFORM_ID);

  readonly messages = signal<StatusMessage[]>([]);
  readonly warningCount = computed(() => this.messages().filter((m) => m.isWarning).length);
  readonly errorCount = computed(() => this.messages().filter((m) => m.isError).length);

  /** Pinned first (most recent first), then the rest — capped at 10 for the summary panel. */
  readonly displayMessages = computed(() => {
    const all = this.messages();
    const pinned = all
      .filter((m) => m.isPinned)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const unpinned = all.filter((m) => !m.isPinned);
    return [...pinned, ...unpinned].slice(0, 10);
  });

  /** Next synthetic id for ephemeral (never-persisted) entries — negative so it can never collide with a real serial id. */
  private nextLocalId = -1;
  private wsOpenCount = 0;

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return; // SSR guard

    this.hydrate();
    this.api.wsMessage$.subscribe((msg) => this.handleWsEvent(msg.event, msg.payload));
    this.api.wsOpen$.subscribe(() => {
      this.wsOpenCount++;
      if (this.wsOpenCount > 1) this.hydrate();
    });
  }

  private hydrate() {
    this.api.getMessages().subscribe({
      next: (rows) => this.messages.set(rows.map((r) => this.fromApi(r))),
    });
  }

  private fromApi(row: ApiMessage): StatusMessage {
    return {
      id: row.id,
      text: row.text,
      createdAt: row.createdAt,
      isWarning: row.isWarning,
      isError: row.isError,
      isPinned: row.isPinned,
      category: row.category,
    };
  }

  private handleWsEvent(event: string, payload: unknown) {
    switch (event) {
      case 'system:message': {
        const row = payload as ApiMessage;
        this.upsert(this.fromApi(row));
        break;
      }
      case 'system:alert': {
        const p = payload as { text: string; severity: string; category?: string; isPinned?: boolean };
        this.append({
          id: this.nextLocalId--,
          text: p.text,
          createdAt: new Date().toISOString(),
          isWarning: p.severity !== 'info',
          isError: p.severity === 'error',
          isPinned: p.isPinned ?? false,
          category: p.category,
        });
        break;
      }
      case 'ai:analysis_complete':
        // The row is inserted server-side before this event fires, but it's
        // broadcast without an id/createdAt — re-fetch to pick it up properly.
        this.hydrate();
        break;
    }
  }

  private append(message: StatusMessage) {
    this.messages.update((prev) => [message, ...prev]);
  }

  private upsert(message: StatusMessage) {
    this.messages.update((prev) => [message, ...prev.filter((m) => m.id !== message.id)]);
  }

  // ── Commands (all via backend) ──────────────────────────────────────────

  /** Persists a status message. Appears in the list via the system:message
   *  WS broadcast; if the backend itself can't be reached, falls back to a
   *  local-only ephemeral entry so the user still sees the feedback. */
  post(text: string, opts: PostMessageOptions = {}) {
    this.api.postMessage({ text, ...opts }).subscribe({
      error: () => {
        this.append({
          id: this.nextLocalId--,
          text,
          createdAt: new Date().toISOString(),
          isWarning: opts.isWarning ?? false,
          isError: opts.isError ?? false,
          isPinned: opts.isPinned ?? false,
          category: opts.category,
        });
      },
    });
  }

  pin(id: number, pin: boolean) {
    this.api.pinMessage(id, pin).subscribe({
      next: () => {
        this.messages.update((prev) => prev.map((m) => (m.id === id ? { ...m, isPinned: pin } : m)));
      },
    });
  }

  unpinCategory(category: string) {
    if (!category) return;
    this.api.unpinCategory(category).subscribe({
      next: () => {
        this.messages.update((prev) =>
          prev.map((m) => (m.category === category ? { ...m, isPinned: false, isWarning: false, isError: false } : m)),
        );
      },
    });
  }

  remove(id: number) {
    this.api.deleteMessage(id).subscribe({
      next: () => this.messages.update((prev) => prev.filter((m) => m.id !== id)),
    });
  }
}
