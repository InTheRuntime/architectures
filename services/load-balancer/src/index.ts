import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { type BalancingAlgorithm, UpstreamPool } from "./pool.js";
import { forwardRequest } from "./proxy.js";

const app = new Hono();

// Global upstream pool initialized with 2 default instances (configurable via env)
const pool = new UpstreamPool({
  algorithm: "round-robin",
  healthCheckIntervalMs: 5000,
});

// Seed default upstream targets (can be overridden or added dynamically)
const initialTargets = process.env.UPSTREAM_URLS
  ? process.env.UPSTREAM_URLS.split(",")
  : ["http://127.0.0.1:8081", "http://127.0.0.1:8082"];

for (const target of initialTargets) {
  pool.addTarget(target.trim());
}

// -------------------------------------------------------------
// Administration & Inspection Endpoints
// -------------------------------------------------------------

app.get("/_admin/targets", (c) => {
  const all = pool.getAllTargets();
  const healthy = pool.getHealthyTargets();
  return c.json({
    algorithm: pool.algorithm,
    total_targets: all.length,
    healthy_targets: healthy.length,
    targets: all,
  });
});

app.post("/_admin/targets", async (c) => {
  const body = await c.req.json<{ url: string }>();
  if (!body.url) {
    return c.json({ error: "Missing required 'url' parameter" }, 400);
  }
  pool.addTarget(body.url);
  return c.json({ status: "added", url: body.url, targets: pool.getAllTargets() });
});

app.delete("/_admin/targets", async (c) => {
  const body = await c.req.json<{ url: string }>();
  if (!body.url) {
    return c.json({ error: "Missing required 'url' parameter" }, 400);
  }
  const removed = pool.removeTarget(body.url);
  return c.json({ status: removed ? "removed" : "not_found", url: body.url });
});

app.post("/_admin/algorithm", async (c) => {
  const body = await c.req.json<{ algorithm: BalancingAlgorithm }>();
  if (body.algorithm !== "round-robin" && body.algorithm !== "least-connections") {
    return c.json({ error: "Algorithm must be 'round-robin' or 'least-connections'" }, 400);
  }
  pool.algorithm = body.algorithm;
  return c.json({ status: "updated", algorithm: pool.algorithm });
});

// -------------------------------------------------------------
// Universal Reverse Proxy Ingress (All traffic forwarded)
// -------------------------------------------------------------

app.all("/*", async (c) => {
  const url = new URL(c.req.url);
  const pathWithQuery = `${url.pathname}${url.search}`;
  return forwardRequest(pool, c.req.raw, pathWithQuery);
});

const port = Number(process.env.PORT) || 8080;
console.log(`Reverse Proxy & Load Balancer listening on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
