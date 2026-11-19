import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { trackSendQueue } from './sendQueue';

describe('trackSendQueue', () => {
  it('버퍼에 넣은 만큼 늘고, transport로 넘기면 준다', () => {
    const conn = new EventEmitter();
    const queue = trackSendQueue(conn);
    const a = { type: 'message', data: 'x'.repeat(10) };
    const b = { type: 'message', data: Buffer.alloc(5) };
    const ping = { type: 'ping' };
    conn.emit('packetCreate', a);
    conn.emit('packetCreate', b);
    conn.emit('packetCreate', ping);
    expect(queue.size).toBe(15);
    conn.emit('flush', [a, b, ping]);
    expect(queue.size).toBe(0);
  });

  it('넘긴 묶음만 빼고 나머지는 남긴다', () => {
    const conn = new EventEmitter();
    const queue = trackSendQueue(conn);
    const a = { data: 'abc' };
    conn.emit('packetCreate', a);
    conn.emit('flush', [a]);
    conn.emit('packetCreate', { data: 'defg' });
    expect(queue.size).toBe(4);
  });
});
