import { Redis } from "ioredis";
import type { ReplayedMessage } from "../types.js";
import type { ReplayBufferAdapter, ReplayRangeResult } from "./adapter.js";

export interface RedisStreamReplayConfig {
  redis?: Redis;
  redisUrl?: string;
  host?: string;
  port?: number;
  prefix?: string;
  capacity?: number;
}

/**
 * Production Redis Streams Replay Buffer.
 * Uses atomic Redis counters for sequence IDs and Redis Streams (XADD with MAXLEN)
 * for persistent message history.
 */
export class RedisStreamReplayBuffer implements ReplayBufferAdapter {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly capacity: number;
  private readonly ownsClient: boolean;

  constructor(config: RedisStreamReplayConfig = {}) {
    this.prefix = config.prefix ?? "ws:stream:";
    this.capacity = config.capacity ?? 1000;

    if (config.redis) {
      this.redis = config.redis;
      this.ownsClient = false;
    } else if (config.redisUrl) {
      this.redis = new Redis(config.redisUrl, { lazyConnect: true });
      this.ownsClient = true;
    } else {
      const host = config.host ?? process.env.REDIS_HOST ?? "localhost";
      const port = config.port ?? Number(process.env.REDIS_PORT) ?? 6379;
      this.redis = new Redis({ host, port, lazyConnect: true });
      this.ownsClient = true;
    }
  }

  public async connect(): Promise<void> {
    if (this.ownsClient && this.redis.status === "wait") {
      await this.redis.connect();
    }
  }

  public async append(
    room: string,
    sender: string,
    payload: unknown,
    timestamp_ms?: number,
  ): Promise<{ seq: number; message: ReplayedMessage }> {
    const seqKey = `${this.prefix}seq:${room}`;
    const streamKey = `${this.prefix}room:${room}`;
    const ts = timestamp_ms ?? Date.now();

    // 1. Increment atomic sequence counter
    const seq = await this.redis.incr(seqKey);

    const message: ReplayedMessage = {
      seq,
      sender,
      payload,
      timestamp_ms: ts,
    };

    // 2. Append to Redis Stream with approximate trimming
    await this.redis.xadd(
      streamKey,
      "MAXLEN",
      "~",
      this.capacity,
      "*",
      "seq",
      String(seq),
      "sender",
      sender,
      "payload",
      JSON.stringify(payload),
      "ts",
      String(ts),
    );

    return { seq, message };
  }

  public async getRange(
    room: string,
    fromSeqExclusive: number,
    limit?: number,
  ): Promise<ReplayRangeResult> {
    const seqKey = `${this.prefix}seq:${room}`;
    const streamKey = `${this.prefix}room:${room}`;

    const currentSeqRaw = await this.redis.get(seqKey);
    const currentSeq = currentSeqRaw ? Number(currentSeqRaw) : 0;

    if (currentSeq === 0 || fromSeqExclusive >= currentSeq) {
      return {
        messages: [],
        currentSeq,
        oldestSeq: 0,
        isExpired: false,
      };
    }

    // Read stream messages from oldest to newest
    const rawEntries = await this.redis.xrange(streamKey, "-", "+");
    if (!rawEntries || rawEntries.length === 0) {
      return {
        messages: [],
        currentSeq,
        oldestSeq: 0,
        isExpired: false,
      };
    }

    const messages: ReplayedMessage[] = [];
    for (const [_id, fields] of rawEntries) {
      // fields is an array of [key1, val1, key2, val2, ...]
      const entry: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        entry[fields[i]] = fields[i + 1];
      }

      if (entry.seq && entry.sender && entry.payload) {
        messages.push({
          seq: Number(entry.seq),
          sender: entry.sender,
          payload: JSON.parse(entry.payload),
          timestamp_ms: Number(entry.ts || 0),
        });
      }
    }

    if (messages.length === 0) {
      return {
        messages: [],
        currentSeq,
        oldestSeq: 0,
        isExpired: false,
      };
    }

    const oldestSeq = messages[0].seq;

    // Buffer overflow check
    if (fromSeqExclusive < oldestSeq - 1) {
      return {
        messages: [],
        currentSeq,
        oldestSeq,
        isExpired: true,
      };
    }

    let eligible = messages.filter((m) => m.seq > fromSeqExclusive);
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
    const seqKey = `${this.prefix}seq:${room}`;
    const val = await this.redis.get(seqKey);
    return val ? Number(val) : 0;
  }

  public async clear(room: string): Promise<void> {
    const seqKey = `${this.prefix}seq:${room}`;
    const streamKey = `${this.prefix}room:${room}`;
    await this.redis.del(seqKey, streamKey);
  }

  public async disconnect(): Promise<void> {
    if (this.ownsClient) {
      await this.redis.quit();
    }
  }
}
