import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { type RateLimitPolicy, type RateLimitResult, RedisTokenBucket } from "./limiter.js";

const app = new Hono();
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const limiter = new RedisTokenBucket(redisUrl);

// Attempt Redis connection in background
limiter.init().catch(() => {
  console.log("Running in local in-memory fallback mode (Redis offline)");
});

/**
 * Injects standard IETF RateLimit headers into the response.
 */
function setRateLimitHeaders(
  c: { header: (key: string, val: string) => void },
  result: RateLimitResult,
): void {
  c.header("RateLimit-Limit", result.limit.toString());
  c.header("RateLimit-Remaining", result.remaining.toString());
  c.header("RateLimit-Reset", result.resetAfterSecs.toString());

  if (!result.allowed) {
    c.header("Retry-After", result.retryAfterSecs.toString());
  }
}

// 1. Health check
app.get("/health", (c) => c.json({ status: "ok", service: "rate-limiter" }));

// 2. Centralized check API (for API Gateways & Proxies)
app.post("/v1/rate-limit/check", async (c) => {
  const body = await c.req.json<{
    key: string;
    capacity: number;
    refill_rate: number;
    cost?: number;
  }>();

  const policy: RateLimitPolicy = {
    capacity: body.capacity || 10,
    refillRate: body.refill_rate || 2.0,
  };

  const result = await limiter.check(body.key, policy, body.cost || 1);
  setRateLimitHeaders(c, result);

  if (result.allowed) {
    return c.json(result, 200);
  }

  return c.json(
    {
      error: "too_many_requests",
      message: `Rate limit quota exceeded. Retry after ${result.retryAfterSecs} seconds.`,
      retry_after_secs: result.retryAfterSecs,
    },
    429,
  );
});

// 3. Interactive Protected Demo Endpoint
app.get("/v1/demo/protected", async (c) => {
  // Use client IP or header fallback
  const ip = c.req.header("x-forwarded-for") || "127.0.0.1";
  const demoPolicy: RateLimitPolicy = {
    capacity: 5, // Burst of 5 requests
    refillRate: 1.0, // Refills 1 request per second
  };

  const result = await limiter.check(`demo:ip:${ip}`, demoPolicy, 1);
  setRateLimitHeaders(c, result);

  if (result.allowed) {
    return c.json({
      message: "Access granted! Welcome to the protected resource.",
      client_ip: ip,
      rate_limit: {
        burst_capacity: result.limit,
        remaining_tokens: result.remaining,
        refill_rate: "1 token / sec",
      },
    });
  }

  return c.json(
    {
      error: "too_many_requests",
      message: `Rate limit exceeded! You have depleted your token bucket. Retry in ${result.retryAfterSecs}s.`,
      client_ip: ip,
      retry_after_secs: result.retryAfterSecs,
    },
    429,
  );
});

const port = Number(process.env.PORT) || 8081;
console.log(`🚀 Rate Limiter service running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
