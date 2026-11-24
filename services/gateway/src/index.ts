import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { GatewayPipeline } from "./pipeline.js";

const app = new Hono();
const pipeline = new GatewayPipeline();

// -------------------------------------------------------------
// Seed Showcase Routes
// -------------------------------------------------------------

// Route 1: /api/public (Public, Cached for 10s, Rate-limited: burst 10, refill 2/s)
pipeline.registerRoute({
  id: "route-public",
  pathPrefix: "/api/public",
  upstreams: ["http://127.0.0.1:8081", "http://127.0.0.1:8082"],
  rateLimit: {
    capacity: 10,
    refillRate: 2.0,
  },
  auth: {
    required: false,
    requiredMask: 0n,
  },
  cache: {
    enabled: true,
    ttlMs: 10_000,
  },
});

// Route 2: /api/admin (Protected: Requires PERM_ADMIN = 0x08, Rate-limited: burst 5, refill 1/s)
pipeline.registerRoute({
  id: "route-admin",
  pathPrefix: "/api/admin",
  upstreams: ["http://127.0.0.1:8081"],
  rateLimit: {
    capacity: 5,
    refillRate: 1.0,
  },
  auth: {
    required: true,
    requiredMask: 0x08n, // Bit 3 = ADMIN
  },
  cache: {
    enabled: false,
    ttlMs: 0,
  },
});

// -------------------------------------------------------------
// Gateway Administration & Observability
// -------------------------------------------------------------

app.get("/_gateway/routes", (c) => c.json(pipeline.getRoutes()));

app.get("/_gateway/stats", (c) => c.json(pipeline.getStats()));

// -------------------------------------------------------------
// Master Ingress (Intercepts and routes all application traffic)
// -------------------------------------------------------------

app.all("/*", async (c) => {
  const clientIp = c.req.header("x-forwarded-for") || "127.0.0.1";
  return pipeline.handleRequest(c.req.raw, clientIp);
});

const port = Number(process.env.PORT) || 8000;
console.log(`🚀 Unified API Gateway listening on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
