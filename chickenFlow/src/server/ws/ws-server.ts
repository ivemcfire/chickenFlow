import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { wsBroadcaster } from './ws-broadcaster.js';
import type { WsEnvelope } from '../api/types.js';

export function attachWebSocketServer(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (socket: WebSocket) => {
    socket.send(JSON.stringify({ event: 'connected', payload: { ts: Date.now() } }));

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { event: string };
        if (msg.event === 'ping') socket.send(JSON.stringify({ event: 'pong', ts: Date.now() }));
      } catch {
        // ignore malformed messages
      }
    });

    socket.on('error', (err) => console.error('[WS] Client error:', err.message));
  });

  wsBroadcaster.on('broadcast', (envelope: WsEnvelope) => {
    const payload = JSON.stringify(envelope);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
  });

  console.log('[WS] WebSocket server attached on /ws');
}
