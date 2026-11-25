import { Redis } from "ioredis";
import type { PresenceAdapter } from "./adapter.js";

export interface RedisPresenceConfig {
  redis?: Redis;
  redisUrl?: string;
  host?: string;
  port?: number;
  prefix?: string;
  defaultPresenceTtlMs?: number;
  defaultTypingTtlMs?: number;
}

/**
 * Production Redis Presence Adapter.
 *
 * Implements Sliding Window Heartbeat Roster using Redis Sorted Sets:
 * - Key: `${prefix}roster:${room}`
 * - Score: timestamp in milliseconds (`Date.now()`)
 * - Member: `userId`
 *
 * Operations:
 * 1. Heartbeat: `ZADD key now userId` (O(log N))
 * 2. Prune Dead Users: `ZREMRANGEBYSCORE key -inf (now - ttlMs)` (O(log N + M))
 * 3. Fetch Roster: `ZRANGE key 0 -1` (O(log N + M))
 * 4. Active Count: `ZCARD key` (O(1))
 *
 * Typing Indicators:
 * - Key: `${prefix}typing:${room}`
 * - Score: expiration timestamp in milliseconds (`Date.now() + ttlMs`)
 * - Member: `userId`
 */
export class RedisPresenceAdapter implements PresenceAdapter {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly defaultPresenceTtlMs: number;
  private readonly defaultTypingTtlMs: number;
  private readonly ownsClient: boolean;

  constructor(config: RedisPresenceConfig = {}) {
    this.prefix = config.prefix ?? "ws:presence:";
    this.defaultPresenceTtlMs = config.defaultPresenceTtlMs ?? 15_000;
    this.defaultTypingTtlMs = config.defaultTypingTtlMs ?? 3_000;

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

  public async heartbeat(room: string, userId: string, _ttlMs?: number): Promise<void> {
    const key = `${this.prefix}roster:${room}`;
    const now = Date.now();
    await this.redis.zadd(key, now, userId);
  }

  public async removeUser(room: string, userId: string): Promise<void> {
    const rosterKey = `${this.prefix}roster:${room}`;
    const typingKey = `${this.prefix}typing:${room}`;

    const pipeline = this.redis.pipeline();
    pipeline.zrem(rosterKey, userId);
    pipeline.zrem(typingKey, userId);
    await pipeline.exec();
  }

  public async getOnlineUsers(room: string, ttlMs?: number): Promise<string[]> {
    const key = `${this.prefix}roster:${room}`;
    const now = Date.now();
    const threshold = now - (ttlMs ?? this.defaultPresenceTtlMs);

    // Atomically prune expired entries and fetch active users in one round-trip
    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(key, "-inf", `(${threshold}`);
    pipeline.zrange(key, 0, -1);

    const results = await pipeline.exec();
    if (!results || results.length < 2) return [];

    const [err, users] = results[1];
    if (err) throw err;

    return (users as string[]) || [];
  }

  public async getOnlineCount(room: string, ttlMs?: number): Promise<number> {
    const users = await this.getOnlineUsers(room, ttlMs);
    return users.length;
  }

  public async setTyping(
    room: string,
    userId: string,
    isTyping: boolean,
    ttlMs?: number,
  ): Promise<void> {
    const key = `${this.prefix}typing:${room}`;

    if (!isTyping) {
      await this.redis.zrem(key, userId);
      return;
    }

    const expiresAt = Date.now() + (ttlMs ?? this.defaultTypingTtlMs);
    await this.redis.zadd(key, expiresAt, userId);
  }

  public async getTypingUsers(room: string): Promise<string[]> {
    const key = `${this.prefix}typing:${room}`;
    const now = Date.now();

    // Prune expired typing timestamps and retrieve current typers
    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(key, "-inf", `(${now}`);
    pipeline.zrange(key, 0, -1);

    const results = await pipeline.exec();
    if (!results || results.length < 2) return [];

    const [err, users] = results[1];
    if (err) throw err;

    return (users as string[]) || [];
  }

  public async disconnect(): Promise<void> {
    if (this.ownsClient) {
      await this.redis.quit();
    }
  }
}
