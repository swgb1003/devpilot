import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { protocolVersion, type ActivityRecord, type AgentEventEnvelope } from '@devpilot/contracts';

import { WsTicketStore } from './auth.js';

const websocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length <= 65_535) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class AgentEventHub {
  readonly #clients = new Map<Duplex, number>();

  attach(server: Server, tickets: WsTicketStore, path = '/api/v1/events'): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== path) {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      if (!tickets.consume(url.searchParams.get('ticket') ?? undefined)) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      const key = request.headers['sec-websocket-key'];
      if (
        typeof key !== 'string' ||
        request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        request.headers['sec-websocket-version'] !== '13'
      ) {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }

      const accept = createHash('sha1').update(`${key}${websocketGuid}`).digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.#clients.set(socket, 0);
      const remove = (): void => {
        this.#clients.delete(socket);
      };
      socket.once('close', remove);
      socket.once('error', remove);
      socket.on('data', (data: Buffer) => {
        const opcode = data[0] === undefined ? 0 : data[0] & 0x0f;
        if (opcode === 0x08) {
          socket.end(Buffer.from([0x88, 0x00]));
          remove();
        } else if (opcode === 0x09) {
          socket.write(Buffer.from([0x8a, 0x00]));
        }
      });
    });
  }

  publishActivity(activity: ActivityRecord, traceId = randomUUID()): void {
    for (const [client, previousSequence] of this.#clients) {
      if (!client.destroyed && client.writable) {
        const sequence = previousSequence + 1;
        const event: AgentEventEnvelope<ActivityRecord> = {
          protocolVersion,
          eventId: randomUUID(),
          eventType: 'activity.created',
          occurredAt: new Date().toISOString(),
          traceId,
          sequence,
          payload: activity,
        };
        this.#clients.set(client, sequence);
        client.write(textFrame(JSON.stringify(event)));
      }
    }
  }

  close(): void {
    for (const client of this.#clients.keys()) {
      client.end(Buffer.from([0x88, 0x00]));
    }
    this.#clients.clear();
  }
}
