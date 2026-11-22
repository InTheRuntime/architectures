import assert from "node:assert";
import test from "node:test";
import { InMemoryTokenBucket } from "../dist/limiter.js";

test("Token Bucket Rate Limiter - Sequential Consumption and Depletion", () => {
  const limiter = new InMemoryTokenBucket();
  const policy = { capacity: 3, refillRate: 1.0 };
  const key = "user_test_1";

  // Request 1: remaining should be 2
  const r1 = limiter.check(key, policy, 1);
  assert.strictEqual(r1.allowed, true);
  assert.strictEqual(r1.remaining, 2);
  assert.strictEqual(r1.limit, 3);

  // Request 2: remaining should be 1
  const r2 = limiter.check(key, policy, 1);
  assert.strictEqual(r2.allowed, true);
  assert.strictEqual(r2.remaining, 1);

  // Request 3: remaining should be 0
  const r3 = limiter.check(key, policy, 1);
  assert.strictEqual(r3.allowed, true);
  assert.strictEqual(r3.remaining, 0);

  // Request 4: REJECTED (bucket empty)
  const r4 = limiter.check(key, policy, 1);
  assert.strictEqual(r4.allowed, false);
  assert.strictEqual(r4.remaining, 0);
  assert.ok(r4.retryAfterSecs >= 1);
});

test("Token Bucket Rate Limiter - Continuous Time Refill", async () => {
  const limiter = new InMemoryTokenBucket();
  // Capacity: 2 tokens, Refill: 2 tokens/sec (1 token every 500ms)
  const policy = { capacity: 2, refillRate: 2.0 };
  const key = "user_test_2";

  // Drain all tokens
  limiter.check(key, policy, 1);
  const r2 = limiter.check(key, policy, 1);
  assert.strictEqual(r2.remaining, 0);

  // Immediately checking must be blocked
  const rBlocked = limiter.check(key, policy, 1);
  assert.strictEqual(rBlocked.allowed, false);

  // Wait 600ms (enough for ~1.2 tokens to refill)
  await new Promise((resolve) => setTimeout(resolve, 600));

  // Should now be permitted
  const rRefilled = limiter.check(key, policy, 1);
  assert.strictEqual(rRefilled.allowed, true);
});

test("Token Bucket Rate Limiter - Never Exceeds Max Capacity", async () => {
  const limiter = new InMemoryTokenBucket();
  const policy = { capacity: 5, refillRate: 10.0 };
  const key = "user_test_3";

  // Initialize
  limiter.check(key, policy, 1);

  // Wait 200ms (2 tokens would refill, but max is 5)
  await new Promise((resolve) => setTimeout(resolve, 200));

  const check = limiter.check(key, policy, 0);
  assert.ok(check.remaining <= 5);
});
