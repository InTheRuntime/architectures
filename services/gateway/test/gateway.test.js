import assert from "node:assert";
import test from "node:test";
import { GatewayPipeline } from "../dist/pipeline.js";

test("Unified Gateway - Rate Limiting Defense Blocks Floods", async () => {
  const pipeline = new GatewayPipeline();
  pipeline.registerRoute({
    id: "test-route",
    pathPrefix: "/api/test",
    upstreams: ["http://127.0.0.1:9999"],
    rateLimit: { capacity: 2, refillRate: 1.0 }, // Burst of 2
    auth: { required: false, requiredMask: 0n },
    cache: { enabled: false, ttlMs: 0 },
  });

  const req1 = new Request("http://localhost:8000/api/test");
  const res1 = await pipeline.handleRequest(req1, "client_ip_1");
  // 502 because dummy upstream 9999 is offline, but passed rate limit!
  assert.strictEqual(res1.status, 502);
  assert.strictEqual(res1.headers.get("RateLimit-Remaining"), "1");

  const req2 = new Request("http://localhost:8000/api/test");
  const res2 = await pipeline.handleRequest(req2, "client_ip_1");
  assert.strictEqual(res2.headers.get("RateLimit-Remaining"), "0");

  // Third request must be blocked by rate limiter with 429!
  const req3 = new Request("http://localhost:8000/api/test");
  const res3 = await pipeline.handleRequest(req3, "client_ip_1");
  assert.strictEqual(res3.status, 429);
  assert.strictEqual(res3.headers.get("Retry-After"), "1");
});

test("Unified Gateway - Bitwise RBAC Rejects Unauthorized Callers", async () => {
  const pipeline = new GatewayPipeline();
  pipeline.registerRoute({
    id: "admin-route",
    pathPrefix: "/api/admin",
    upstreams: ["http://127.0.0.1:9999"],
    rateLimit: { capacity: 10, refillRate: 2.0 },
    auth: { required: true, requiredMask: 0x08n }, // Requires bit 3 = 0x08
    cache: { enabled: false, ttlMs: 0 },
  });

  // 1. Missing header -> 401 Unauthorized
  const noAuthReq = new Request("http://localhost:8000/api/admin");
  const resNoAuth = await pipeline.handleRequest(noAuthReq);
  assert.strictEqual(resNoAuth.status, 401);

  // 2. Insufficient token (has 0x03, needs 0x08) -> 403 Forbidden
  const wrongTokenReq = new Request("http://localhost:8000/api/admin", {
    headers: { Authorization: "Bearer 0x0000000000000003" },
  });
  const resWrongToken = await pipeline.handleRequest(wrongTokenReq);
  assert.strictEqual(resWrongToken.status, 403);
  assert.strictEqual(resWrongToken.headers.get("X-Required-Permission"), "0x0000000000000008");

  // 3. Admin token (0x08) -> Passes RBAC check! (Reaches upstream -> 502 since mock upstream offline)
  const adminReq = new Request("http://localhost:8000/api/admin", {
    headers: { Authorization: "Bearer 0x0000000000000008" },
  });
  const resAdmin = await pipeline.handleRequest(adminReq);
  assert.notStrictEqual(resAdmin.status, 401);
  assert.notStrictEqual(resAdmin.status, 403);
});

test("Unified Gateway - Telemetry Correctly Aggregates Pipeline Metrics", async () => {
  const pipeline = new GatewayPipeline();
  pipeline.registerRoute({
    id: "telemetry-route",
    pathPrefix: "/test",
    upstreams: ["http://127.0.0.1:9999"],
    rateLimit: { capacity: 1, refillRate: 1.0 },
    auth: { required: true, requiredMask: 0x01n },
    cache: { enabled: false, ttlMs: 0 },
  });

  // 1. Cause auth rejection
  await pipeline.handleRequest(new Request("http://localhost:8000/test"));

  const stats = pipeline.getStats();
  assert.strictEqual(stats.totalRequests, 1);
  assert.strictEqual(stats.authRejectedRequests, 1);
});
