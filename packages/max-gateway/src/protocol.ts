/** Tunnel frame: uint32be streamId | uint8 type | uint32be payloadLength | payload.
 * Stream 0 is ping/pong; HTTP uses head/chunk frames, WS a flag byte then raw data. */

export const MAX_FRAME_PAYLOAD = 8 * 1024 * 1024;

/**
 * Set only by the gateway, on T3's public bootstrap requests from a visitor with no MAX
 * session. The companion then forwards them without the bearer. Clients cannot set it.
 */
export const ANONYMOUS_REQUEST_HEADER = "x-max-anonymous";

/**
 * Close codes received from the far end (1005 no status, 1006 abnormal, 1004) make `ws`
 * throw in `close()`, which would take the tunnel down. Both ends forward them as 1000.
 */
export function sendableCloseCode(code: number): number {
  const valid =
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999);
  return valid ? code : 1000;
}

export const FrameType = {
  httpRequest: 1,
  httpRequestChunk: 2,
  httpRequestEnd: 3,
  httpResponseHead: 4,
  httpResponseChunk: 5,
  httpResponseEnd: 6,
  wsOpen: 7,
  wsOpenResult: 8,
  wsMessage: 9,
  wsClose: 10,
  ping: 11,
  pong: 12,
  streamError: 13,
  httpAbort: 14,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export interface DecodedFrame {
  readonly streamId: number;
  readonly type: number;
  readonly payload: Buffer;
}

export interface HttpRequestFrame {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
}

export interface HttpResponseHeadFrame {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
}

export interface WsOpenFrame {
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly protocols: readonly string[];
}

export interface WsOpenResultFrame {
  readonly ok: boolean;
  readonly protocol?: string;
}

export interface WsCloseFrame {
  readonly code: number;
  readonly reason: string;
}

export interface StreamErrorFrame {
  readonly message: string;
}

const HEADER_BYTES = 9;

export function encodeFrame(streamId: number, type: number, payload: Buffer): Buffer {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new Error("stream id is out of range");
  }
  if (payload.length > MAX_FRAME_PAYLOAD) {
    throw new Error("frame payload is too large");
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame.writeUInt32BE(streamId, 0);
  frame.writeUInt8(type, 4);
  frame.writeUInt32BE(payload.length, 5);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (frame: DecodedFrame) => void): void {
    this.buffer =
      this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= HEADER_BYTES) {
      const streamId = this.buffer.readUInt32BE(0);
      const type = this.buffer.readUInt8(4);
      const length = this.buffer.readUInt32BE(5);
      if (length > MAX_FRAME_PAYLOAD) {
        throw new Error("frame payload is too large");
      }
      if (this.buffer.length < HEADER_BYTES + length) return;
      const payload = Buffer.from(this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length));
      this.buffer = Buffer.from(this.buffer.subarray(HEADER_BYTES + length));
      onFrame({ streamId, type, payload });
    }
  }
}

export function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

export function parseJsonPayload<T>(payload: Buffer): T {
  return JSON.parse(payload.toString("utf8")) as T;
}

export function encodeWsMessage(data: Buffer, binary: boolean): Buffer {
  const frame = Buffer.allocUnsafe(1 + data.length);
  frame[0] = binary ? 1 : 0;
  data.copy(frame, 1);
  return frame;
}

export function decodeWsMessage(payload: Buffer): { data: Buffer; binary: boolean } {
  if (payload.length < 1) {
    throw new Error("websocket message frame is empty");
  }
  const flag = payload[0];
  if (flag !== 0 && flag !== 1) {
    throw new Error("websocket message flag is invalid");
  }
  return { binary: flag === 1, data: Buffer.from(payload.subarray(1)) };
}

export function sendFrames(
  send: (frame: Buffer) => void,
  streamId: number,
  type: number,
  payload: Buffer,
): void {
  const splittable = type === FrameType.httpRequestChunk || type === FrameType.httpResponseChunk;
  if (payload.length <= MAX_FRAME_PAYLOAD) {
    send(encodeFrame(streamId, type, payload));
    return;
  }
  if (!splittable) {
    throw new Error("frame payload is too large");
  }
  for (let offset = 0; offset < payload.length; offset += MAX_FRAME_PAYLOAD) {
    send(
      encodeFrame(
        streamId,
        type,
        payload.subarray(offset, Math.min(payload.length, offset + MAX_FRAME_PAYLOAD)),
      ),
    );
  }
}
