import assert from "node:assert";
import test from "node:test";
import { LruCache } from "../dist/index.js";

test("LRU Cache - Basic Get and Set in O(1)", () => {
  const cache = new LruCache({ capacity: 3 });

  cache.set("a", 100);
  cache.set("b", 200);

  assert.strictEqual(cache.get("a"), 100);
  assert.strictEqual(cache.get("b"), 200);
  assert.strictEqual(cache.get("c"), undefined);

  const stats = cache.getStats();
  assert.strictEqual(stats.hits, 2);
  assert.strictEqual(stats.misses, 1);
});

test("LRU Cache - Evicts Least Recently Used Node when Capacity Exceeded", () => {
  const cache = new LruCache({ capacity: 3 });

  cache.set("key1", "val1");
  cache.set("key2", "val2");
  cache.set("key3", "val3");

  // Read key1 to make it Most Recently Used (MRU). Order is now: key1 -> key3 -> key2 (LRU)
  cache.get("key1");

  // Insert key4. Since capacity is 3, key2 (the least recently accessed) must be evicted!
  cache.set("key4", "val4");

  assert.strictEqual(cache.get("key1"), "val1"); // Still present!
  assert.strictEqual(cache.get("key2"), undefined); // Evicted!
  assert.strictEqual(cache.get("key3"), "val3"); // Still present!
  assert.strictEqual(cache.get("key4"), "val4"); // Still present!

  const stats = cache.getStats();
  assert.strictEqual(stats.evictions, 1);
});

test("LRU Cache - Time-To-Live (TTL) Lazy Expiration", async () => {
  const cache = new LruCache({ capacity: 5 });

  // Set key with a 100ms TTL
  cache.set("short_lived", "alive", 100);
  cache.set("permanent", "forever");

  assert.strictEqual(cache.get("short_lived"), "alive");

  // Wait 150ms for TTL to expire
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Accessing expired key should return undefined and count as expiration
  assert.strictEqual(cache.get("short_lived"), undefined);
  assert.strictEqual(cache.get("permanent"), "forever");

  const stats = cache.getStats();
  assert.strictEqual(stats.expirations, 1);
});

test("LRU Cache - Hit Ratio Telemetry Calculation", () => {
  const cache = new LruCache({ capacity: 10 });

  cache.set("x", "1");
  cache.get("x"); // Hit 1
  cache.get("x"); // Hit 2
  cache.get("y"); // Miss 1
  cache.get("z"); // Miss 2

  // 2 hits out of 4 requests = 50% hit ratio
  const stats = cache.getStats();
  assert.strictEqual(stats.hits, 2);
  assert.strictEqual(stats.misses, 2);
  assert.strictEqual(stats.hitRatio, 0.5);
});
