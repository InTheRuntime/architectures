import { serve } from "@hono/node-server";
import { LruCache } from "@intheruntime/cache";
import { Hono } from "hono";

const app = new Hono();

// Global cache instance: Capacity of 1,000 keys, default TTL of 60 seconds
const cache = new LruCache<string, unknown>({
  capacity: 1000,
  defaultTtlMs: 60_000,
});

// Periodic background sweeper to clean up unread expired keys every 30 seconds
setInterval(() => {
  cache.purgeExpired();
}, 30_000).unref();

// 1. Health check
app.get("/health", (c) => c.json({ status: "ok", service: "cache-engine" }));

// 2. Fetch cache entry
app.get("/v1/cache/:key", (c) => {
  const key = c.req.param("key");
  const value = cache.get(key);
  const stats = cache.getStats();

  if (value === undefined) {
    c.header("X-Cache", "MISS");
    c.header("X-Cache-Hit-Ratio", stats.hitRatio.toString());
    return c.json({ error: "not_found", key }, 404);
  }

  c.header("X-Cache", "HIT");
  c.header("X-Cache-Hit-Ratio", stats.hitRatio.toString());
  return c.json({ key, value });
});

// 3. Insert or update cache entry
app.post("/v1/cache/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json<{ value: unknown; ttl_ms?: number }>();

  cache.set(key, body.value, body.ttl_ms);

  return c.json({
    status: "stored",
    key,
    ttl_ms: body.ttl_ms ?? cache.defaultTtlMs,
    size: cache.size,
  });
});

// 4. Delete cache entry
app.delete("/v1/cache/:key", (c) => {
  const key = c.req.param("key");
  const deleted = cache.delete(key);

  if (!deleted) {
    return c.json({ error: "not_found", key }, 404);
  }

  return c.json({ status: "deleted", key });
});

// 5. Cache statistics & telemetry
app.get("/v1/cache/stats", (c) => {
  return c.json(cache.getStats());
});

// 6. Interactive Demo: Simulated Slow Database Query
app.get("/v1/demo/expensive-query", async (c) => {
  const id = c.req.query("id") || "item_1";
  const cacheKey = `query:item:${id}`;

  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    c.header("X-Cache", "HIT");
    c.header("X-Execution-Time", "< 1ms");
    return c.json({
      source: "in-memory-cache",
      data: cached,
      note: "Instant cache retrieval!",
    });
  }

  // Simulate expensive 300ms database operation
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const duration = Date.now() - start;

  const dbData = {
    itemId: id,
    name: `High-Performance Widget ${id}`,
    generatedAt: new Date().toISOString(),
    queryDurationMs: duration,
  };

  // Cache for 10 seconds
  cache.set(cacheKey, dbData, 10_000);

  c.header("X-Cache", "MISS");
  c.header("X-Execution-Time", `${duration}ms`);
  return c.json({
    source: "simulated-database",
    data: dbData,
    note: "Slow query simulated! Subsequent requests will be instant.",
  });
});

const port = Number(process.env.PORT) || 8082;
console.log(`🚀 Cache Engine running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
