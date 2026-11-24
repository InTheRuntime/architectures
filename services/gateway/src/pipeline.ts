import { randomUUID } from "node:crypto";
import { LruCache } from "@intheruntime/cache";
import { PermissionMask } from "@intheruntime/rbac";
import type { GatewayRoute, GatewayStats } from "./types.js";

interface BucketState {
  tokens: number;
  lastUpdatedMs: number;
}

interface CachedResponse {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
}

/**
 * The Master Pipeline coordinating:
 * 1. Rate Limiting
 * 2. Bitwise RBAC Authorization
 * 3. In-Memory LRU Caching
 * 4. Load-Balanced Upstream Proxying
 */
export class GatewayPipeline {
  private readonly routes: GatewayRoute[] = [];
  private readonly responseCache = new LruCache<string, CachedResponse>({ capacity: 2000 });
  private readonly rateLimitBuckets = new Map<string, BucketState>();

  // Upstream round-robin indices per route
  private readonly routePointers = new Map<string, number>();

  // Telemetry counters
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private rateLimitedRequests = 0;
  private authRejectedRequests = 0;

  public registerRoute(route: GatewayRoute): void {
    this.routes.push(route);
    this.routePointers.set(route.id, 0);
  }

  public getRoutes(): GatewayRoute[] {
    return [...this.routes];
  }

  public getStats(): GatewayStats {
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      rateLimitedRequests: this.rateLimitedRequests,
      authRejectedRequests: this.authRejectedRequests,
      activeRoutes: this.routes.length,
    };
  }

  public matchRoute(pathname: string): GatewayRoute | null {
    for (const route of this.routes) {
      if (pathname.startsWith(route.pathPrefix)) {
        return route;
      }
    }
    return null;
  }

  /**
   * Evaluates the unified pipeline for an inbound HTTP request.
   */
  public async handleRequest(req: Request, clientIp = "127.0.0.1"): Promise<Response> {
    this.totalRequests++;
    const requestId =
      req.headers.get("x-request-id") || `req_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const url = new URL(req.url);
    const pathname = url.pathname;

    const route = this.matchRoute(pathname);
    if (!route) {
      return new Response(
        JSON.stringify({
          error: "not_found",
          message: "No matching route registered in API Gateway",
          path: pathname,
        }),
        { status: 404, headers: { "Content-Type": "application/json", "X-Request-Id": requestId } },
      );
    }

    // -------------------------------------------------------------
    // Step 1: Rate Limiting Evaluation (Level 1)
    // -------------------------------------------------------------
    const rateLimitKey = `${route.id}:${clientIp}`;
    const rateResult = this.checkRateLimit(
      rateLimitKey,
      route.rateLimit.capacity,
      route.rateLimit.refillRate,
    );

    if (!rateResult.allowed) {
      this.rateLimitedRequests++;
      return new Response(
        JSON.stringify({
          error: "too_many_requests",
          message: `Rate limit quota exceeded. Retry after ${rateResult.retryAfterSecs} seconds.`,
          retry_after_secs: rateResult.retryAfterSecs,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": requestId,
            "RateLimit-Limit": rateResult.limit.toString(),
            "RateLimit-Remaining": "0",
            "RateLimit-Reset": rateResult.resetAfterSecs.toString(),
            "Retry-After": rateResult.retryAfterSecs.toString(),
          },
        },
      );
    }

    // -------------------------------------------------------------
    // Step 2: Bitwise RBAC Authorization (Level 0)
    // -------------------------------------------------------------
    if (route.auth.required) {
      const authHeader = req.headers.get("authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        this.authRejectedRequests++;
        return new Response(
          JSON.stringify({
            error: "unauthorized",
            message: "Missing or malformed Authorization header",
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": requestId,
              "WWW-Authenticate": "Bearer",
            },
          },
        );
      }

      const rawToken = authHeader.replace("Bearer ", "").trim();
      let userMask: PermissionMask;
      try {
        userMask = new PermissionMask(rawToken);
      } catch {
        this.authRejectedRequests++;
        return new Response(
          JSON.stringify({ error: "invalid_token", message: "Invalid authorization token format" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
          },
        );
      }

      const requiredMask = new PermissionMask(route.auth.requiredMask);
      if (!userMask.hasPermission(requiredMask)) {
        this.authRejectedRequests++;
        const missing = userMask.missingPermissions(requiredMask);
        return new Response(
          JSON.stringify({
            error: "forbidden",
            message: "Insufficient permissions to access this route",
            required_mask: `0x${requiredMask.toHex()}`,
            provided_mask: `0x${userMask.toHex()}`,
            missing_mask: `0x${missing.toHex()}`,
          }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": requestId,
              "X-Required-Permission": `0x${requiredMask.toHex()}`,
              "X-Provided-Permission": `0x${userMask.toHex()}`,
            },
          },
        );
      }
    }

    // -------------------------------------------------------------
    // Step 3: In-Memory LRU Cache Lookup (Level 2)
    // -------------------------------------------------------------
    const cacheKey = `${route.id}:${req.method}:${url.pathname}${url.search}`;
    if (route.cache.enabled && req.method === "GET") {
      const cached = this.responseCache.get(cacheKey);
      if (cached) {
        this.cacheHits++;
        const resHeaders = new Headers(cached.headers);
        resHeaders.set("X-Cache", "HIT");
        resHeaders.set("X-Request-Id", requestId);
        resHeaders.set("RateLimit-Limit", rateResult.limit.toString());
        resHeaders.set("RateLimit-Remaining", rateResult.remaining.toString());
        resHeaders.set("RateLimit-Reset", rateResult.resetAfterSecs.toString());

        return new Response(cached.body.slice(0), {
          status: cached.status,
          headers: resHeaders,
        });
      }
    }

    this.cacheMisses++;

    // -------------------------------------------------------------
    // Step 4: Upstream Load Balancing Selection (Level 3)
    // -------------------------------------------------------------
    if (route.upstreams.length === 0) {
      return new Response(
        JSON.stringify({ error: "bad_gateway", message: "No upstream targets defined for route" }),
        { status: 502, headers: { "Content-Type": "application/json", "X-Request-Id": requestId } },
      );
    }

    const ptr = this.routePointers.get(route.id) ?? 0;
    const selectedUpstream = route.upstreams[ptr % route.upstreams.length];
    this.routePointers.set(route.id, (ptr + 1) % route.upstreams.length);

    // -------------------------------------------------------------
    // Step 5: Forward Request & Store in Cache
    // -------------------------------------------------------------
    try {
      const targetUrl = `${selectedUpstream}${url.pathname}${url.search}`;
      const forwardHeaders = new Headers(req.headers);
      forwardHeaders.set("X-Forwarded-For", clientIp);
      forwardHeaders.set("X-Request-Id", requestId);
      forwardHeaders.set("X-Gateway-Route-Id", route.id);

      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const bodyData = hasBody ? await req.arrayBuffer() : undefined;

      const upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: bodyData,
      });

      const resBody = await upstreamRes.arrayBuffer();
      const resHeaders = new Headers(upstreamRes.headers);

      resHeaders.set("X-Cache", "MISS");
      resHeaders.set("X-Request-Id", requestId);
      resHeaders.set("X-Served-By-Backend", selectedUpstream);
      resHeaders.set("RateLimit-Limit", rateResult.limit.toString());
      resHeaders.set("RateLimit-Remaining", rateResult.remaining.toString());
      resHeaders.set("RateLimit-Reset", rateResult.resetAfterSecs.toString());

      // Cache eligible GET responses
      if (route.cache.enabled && req.method === "GET" && upstreamRes.status === 200) {
        const headerEntries: [string, string][] = [];
        resHeaders.forEach((val, key) => headerEntries.push([key, val]));

        this.responseCache.set(
          cacheKey,
          {
            status: upstreamRes.status,
            headers: headerEntries,
            body: resBody.slice(0),
          },
          route.cache.ttlMs,
        );
      }

      return new Response(resBody, {
        status: upstreamRes.status,
        headers: resHeaders,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upstream connection failed";
      return new Response(
        JSON.stringify({
          error: "gateway_upstream_error",
          message: msg,
          upstream: selectedUpstream,
        }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": requestId,
            "RateLimit-Limit": rateResult.limit.toString(),
            "RateLimit-Remaining": rateResult.remaining.toString(),
            "RateLimit-Reset": rateResult.resetAfterSecs.toString(),
          },
        },
      );
    }
  }

  // --- Continuous Token Bucket Helper ---
  private checkRateLimit(key: string, capacity: number, refillRate: number) {
    const nowMs = Date.now();
    let bucket = this.rateLimitBuckets.get(key);

    if (!bucket) {
      bucket = { tokens: capacity, lastUpdatedMs: nowMs };
      this.rateLimitBuckets.set(key, bucket);
    }

    const elapsedSecs = Math.max(0, (nowMs - bucket.lastUpdatedMs) / 1000);
    const refilled = bucket.tokens + elapsedSecs * refillRate;
    const currentTokens = Math.min(capacity, refilled);

    if (currentTokens >= 1) {
      const newTokens = currentTokens - 1;
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

    const resetAfterSecs = Math.ceil((capacity - currentTokens) / refillRate);
    const retryAfterSecs = Math.max(1, Math.ceil((1 - currentTokens) / refillRate));

    return {
      allowed: false,
      limit: capacity,
      remaining: 0,
      resetAfterSecs,
      retryAfterSecs,
    };
  }
}
