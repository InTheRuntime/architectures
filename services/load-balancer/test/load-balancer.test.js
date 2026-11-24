import assert from "node:assert";
import test from "node:test";
import { UpstreamPool } from "../dist/pool.js";

test("Load Balancer - Round-Robin Sequential Distribution", () => {
  const pool = new UpstreamPool({ algorithm: "round-robin" });
  pool.addTarget("http://server-1:8080");
  pool.addTarget("http://server-2:8080");
  pool.addTarget("http://server-3:8080");

  const s1 = pool.selectTarget();
  const s2 = pool.selectTarget();
  const s3 = pool.selectTarget();
  const s4 = pool.selectTarget();

  assert.strictEqual(s1?.url, "http://server-1:8080");
  assert.strictEqual(s2?.url, "http://server-2:8080");
  assert.strictEqual(s3?.url, "http://server-3:8080");
  assert.strictEqual(s4?.url, "http://server-1:8080"); // Cycles back to server-1!
});

test("Load Balancer - Least-Connections Selection", () => {
  const pool = new UpstreamPool({ algorithm: "least-connections" });
  pool.addTarget("http://server-1:8080");
  pool.addTarget("http://server-2:8080");

  const targets = pool.getAllTargets();
  // Simulate server-1 handling 5 concurrent requests, server-2 idle (0 requests)
  targets[0].activeConnections = 5;
  targets[1].activeConnections = 0;

  const selected = pool.selectTarget();
  assert.strictEqual(selected?.url, "http://server-2:8080"); // Must pick server-2!
});

test("Load Balancer - Ejects Unhealthy Nodes from Rotation", () => {
  const pool = new UpstreamPool({ algorithm: "round-robin" });
  pool.addTarget("http://server-healthy:8080");
  pool.addTarget("http://server-dead:8080");

  const targets = pool.getAllTargets();
  // Simulate server-dead failing 2 health checks
  targets[1].healthy = false;

  // Requests should ONLY go to server-healthy
  const r1 = pool.selectTarget();
  const r2 = pool.selectTarget();

  assert.strictEqual(r1?.url, "http://server-healthy:8080");
  assert.strictEqual(r2?.url, "http://server-healthy:8080");
});

test("Load Balancer - Returns Null When All Targets Unhealthy", () => {
  const pool = new UpstreamPool();
  pool.addTarget("http://dead-1:8080");
  pool.addTarget("http://dead-2:8080");

  for (const target of pool.getAllTargets()) {
    target.healthy = false;
  }

  const selected = pool.selectTarget();
  assert.strictEqual(selected, null);
});
