import { Redis } from "ioredis";
import { TOKEN_BUCKET_LUA } from "./token-bucket-lua.js";

export interface RateLimitPolicy {
  capacity: number;
  refillRate: number; // Tokens added per second
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterSecs: number;
  retryAfterSecs: number;
}

interface BucketState {
  tokens: number;
  lastUpdatedMs: number;
}

/**
 * Thread-safe In-Memory Token Bucket.
 * Uses lazy evaluation (zero background timers).
 */
export class InMemoryTokenBucket {
  private readonly buckets = new Map<string, BucketState>();

  public check(key: string, policy: RateLimitPolicy, cost = 1): RateLimitResult {
    const nowMs = Date.now();
    const capacity = policy.capacity;
    const refillRate = policy.refillRate;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastUpdatedMs: nowMs };
      this.buckets.set(key, bucket);
    }

    // 1. Calculate time delta in seconds
    const elapsedSecs = Math.max(0, (nowMs - bucket.lastUpdatedMs) / 1000);

    // 2. Continuous refill: tokens = min(capacity, current + delta * rate)
    const refilled = bucket.tokens + elapsedSecs * refillRate;
    const currentTokens = Math.min(capacity, refilled);

    if (currentTokens >= cost) {
      const newTokens = currentTokens - cost;
      bucket.tokens = newTokens;
      bucket.lastUpdatedMs = nowMs;

      const resetAfterSecs = Math.ceil((capacity - newTokens) / refillRate);

      return {
        allowed: true,
        limit: capacity,
        remaining: Math.floor(newTokens),
        resetAfterSecs,
        retryAfterSecs: 0,
      };
    }

    // Throttled
    const resetAfterSecs = Math.ceil((capacity - currentTokens) / refillRate);
    const retryAfterSecs = Math.max(1, Math.ceil((cost - currentTokens) / refillRate));

    return {
      allowed: false,
      limit: capacity,
      remaining: 0,
      resetAfterSecs,
      retryAfterSecs,
    };
  }

  public reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }
}

/**
 * Distributed Redis Token Bucket Rate Limiter.
 * Executes atomic Lua script to eliminate race conditions across clusters.
 */
export class RedisTokenBucket {
  private readonly redis: Redis;
  private readonly inMemoryFallback = new InMemoryTokenBucket();
  private isConnected = false;

  constructor(redisUrl = "redis://127.0.0.1:6379") {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    this.redis.on("connect", () => {
      this.isConnected = true;
    });

    this.redis.on("error", () => {
      this.isConnected = false;
    });
  }

  public async init(): Promise<void> {
    try {
      await this.redis.connect();
      this.isConnected = true;
    } catch {
      this.isConnected = false;
    }
  }

  public async check(key: string, policy: RateLimitPolicy, cost = 1): Promise<RateLimitResult> {
    if (!this.isConnected) {
      return this.inMemoryFallback.check(key, policy, cost);
    }

    try {
      const redisKey = `rl:${key}`;
      const nowSecs = Date.now() / 1000;

      const res = (await this.redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        redisKey,
        policy.capacity,
        policy.refillRate,
        cost,
        nowSecs,
      )) as [number, number, number, number];

      const allowed = res[0] === 1;
      const remaining = res[1];
      const resetAfterSecs = res[2];
      const retryAfterSecs = res[3];

      return {
        allowed,
        limit: policy.capacity,
        remaining,
        resetAfterSecs,
        retryAfterSecs,
      };
    } catch {
      // Transparent fallback on Redis failure
      return this.inMemoryFallback.check(key, policy, cost);
    }
  }

  public getFallback(): InMemoryTokenBucket {
    return this.inMemoryFallback;
  }
}
