// 소켓 하나로 아직 못 보낸 양을 센다 — engine.io 송신 버퍼(writeBuffer)에 쌓인 패킷의 글자 수.
// 받는 쪽 회선이 느리면 transport가 쓰기 가능해질 때까지 패킷이 여기 쌓인다(서버 메모리).
// writeBuffer는 비공개라 이벤트로 센다: 'packetCreate'(버퍼에 넣기 직전) +, 'flush'(transport로 넘김) −
import type { EventEmitter } from 'node:events';

interface Packet {
  data?: unknown;
}

export interface SendQueue {
  // 아직 transport로 넘기지 못한 글자 수(문자열은 길이, 바이너리는 바이트)
  readonly size: number;
}

const sizeOf = (data: unknown): number => {
  if (typeof data === 'string') return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
};

export const trackSendQueue = (conn: EventEmitter): SendQueue => {
  let size = 0;
  conn.on('packetCreate', (packet: Packet) => {
    size += sizeOf(packet?.data);
  });
  conn.on('flush', (packets: Packet[]) => {
    for (const packet of packets) size -= sizeOf(packet?.data);
    if (size < 0) size = 0;
  });
  return {
    get size() {
      return size;
    },
  };
};
