import type { ReplayedMessage } from "../types.js";

export interface ReplayRangeResult {
  messages: ReplayedMessage[];
  currentSeq: number;
  oldestSeq: number;
  isExpired: boolean;
}

/**
 * Interface for stream buffers that store historical room messages
 * and allow reconnecting clients to catch up without message loss.
 */
export interface ReplayBufferAdapter {
  /**
   * Append a message to the room's replay buffer and assign a monotonic sequence ID.
   */
  append(
    room: string,
    sender: string,
    payload: unknown,
    timestamp_ms?: number,
  ): Promise<{ seq: number; message: ReplayedMessage }>;

  /**
   * Retrieve messages starting strictly after `fromSeqExclusive`.
   * If `fromSeqExclusive` is older than the oldest retained message,
   * `isExpired` is set to true.
   */
  getRange(room: string, fromSeqExclusive: number, limit?: number): Promise<ReplayRangeResult>;

  /**
   * Get the current highest sequence ID for a room.
   */
  getCurrentSeq(room: string): Promise<number>;

  /**
   * Clear buffer for a specific room.
   */
  clear(room: string): Promise<void>;

  /**
   * Disconnect and release resources.
   */
  disconnect(): Promise<void>;
}
