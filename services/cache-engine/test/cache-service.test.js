import assert from "node:assert";
import test from "node:test";
import { LruCache } from "@intheruntime/cache";

test("Cache Service Logic - End to End Caching and Eviction Flow", () => {
  // Capacity: 2 keys
  const cache = new LruCache({ capacity: 2 });

  // 1. Initial misses
  assert.strictEqual(cache.get("user:1"), undefined);
  assert.strictEqual(cache.getStats().misses, 1);

  // 2. Insert item 1 and item 2
  cache.set("user:1", { name: "Alice" });
  cache.set("user:2", { name: "Bob" });

  // 3. Cache hit on item 1 (makes item 1 MRU, item 2 is now LRU)
  const hit = cache.get("user:1");
  assert.deepStrictEqual(hit, { name: "Alice" });
  assert.strictEqual(cache.getStats().hits, 1);

  // 4. Insert item 3. Should evict item 2 (LRU)!
  cache.set("user:3", { name: "Charlie" });

  assert.deepStrictEqual(cache.get("user:1"), { name: "Alice" }); // Kept!
  assert.strictEqual(cache.get("user:2"), undefined); // Evicted!
  assert.deepStrictEqual(cache.get("user:3"), { name: "Charlie" }); // Kept!

  assert.strictEqual(cache.getStats().evictions, 1);
});
