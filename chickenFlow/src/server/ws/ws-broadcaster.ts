import { EventEmitter } from 'node:events';
import type { WsEventName, WsEnvelope } from '../api/types.js';

class WsBroadcaster extends EventEmitter {
  broadcast(event: WsEventName, payload: unknown): void {
    this.emit('broadcast', { event, payload, ts: Date.now() } satisfies WsEnvelope);
  }
}

export const wsBroadcaster = new WsBroadcaster();
