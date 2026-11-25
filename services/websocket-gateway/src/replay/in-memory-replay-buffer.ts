import type { ReplayedMessage } from "../types.js";
import type { ReplayBufferAdapter, ReplayRangeResult } from "./adapter.js";

interface RoomBufferState {
  currentSeq: number;
  messages: ReplayedMessage[];
}

/**
 * High-performance In-Memory Ring Buffer per room.
 * Keeps the most recent K messages for instant O(1) replay.
 */
export class InMemoryReplayBuffer implements ReplayBufferAdapter {
  private readonly capacity: number;
  private readonly rooms = new Map<string, RoomBufferState>();

  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? 500;
  }

  private getOrCreateRoom(room: string): RoomBufferState {
    let state = this.rooms.get(room);
    if (!state) {
      state = { currentSeq: 0, messages: [] };
      this.rooms.set(room, state);
    }
    return state;
  }

  public async append(
    room: string,
    sender: string,
    payload: unknown,
    timestamp_ms?: number,
  ): Promise<{ seq: number; message: ReplayedMessage }> {
    const state = this.getOrCreateRoom(room);
    state.currentSeq += 1;

    const message: ReplayedMessage = {
      seq: state.currentSeq,
      sender,
      payload,
      timestamp_ms: timestamp_ms ?? Date.now(),
    };

    state.messages.push(message);

    // Evict oldest if capacity exceeded
    if (state.messages.length > this.capacity) {
      state.messages.shift();
    }

    return { seq: state.currentSeq, message };
  }

  public async getRange(
    room: string,
    fromSeqExclusive: number,
    limit?: number,
  ): Promise<ReplayRangeResult> {
    const state = this.rooms.get(room);
    if (!state || state.messages.length === 0) {
      return {
        messages: [],
        currentSeq: state?.currentSeq ?? 0,
        oldestSeq: 0,
        isExpired: false,
      };
    }

    const oldestSeq = state.messages[0].seq;
    const currentSeq = state.currentSeq;

    // Client is completely up-to-date
    if (fromSeqExclusive >= currentSeq) {
      return {
        messages: [],
        currentSeq,
        oldestSeq,
        isExpired: false,
      };
    }

    // Client's offset has been purged from the ring buffer (Buffer Overflow)
    if (fromSeqExclusive < oldestSeq - 1) {
      return {
        messages: [],
        currentSeq,
        oldestSeq,
        isExpired: true,
      };
    }

    // Filter messages with seq > fromSeqExclusive
    let eligible = state.messages.filter((m) => m.seq > fromSeqExclusive);
    if (limit && limit > 0) {
      eligible = eligible.slice(0, limit);
    }

    return {
      messages: eligible,
      currentSeq,
      oldestSeq,
      isExpired: false,
    };
  }

  public async getCurrentSeq(room: string): Promise<number> {
    return this.rooms.get(room)?.currentSeq ?? 0;
  }

  public async clear(room: string): Promise<void> {
    this.rooms.delete(room);
  }

  public async disconnect(): Promise<void> {
    this.rooms.clear();
  }
}
