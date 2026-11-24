import { randomUUID } from "node:crypto";
import type { BackendTarget, UpstreamPool } from "./pool.js";

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

/**
 * Handles forwarding of incoming HTTP requests to the selected upstream backend target.
 */
export async function forwardRequest(
  pool: UpstreamPool,
  req: Request,
  urlPath: string,
): Promise<Response> {
  const target: BackendTarget | null = pool.selectTarget();

  if (!target) {
    return new Response(
      JSON.stringify({
        error: "bad_gateway",
        message: "No healthy upstream backend instances available to serve this request.",
        code: 502,
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Increment active connection count for Least-Connections algorithm
  target.activeConnections++;

  const requestId =
    req.headers.get("x-request-id") || `req_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const upstreamUrl = `${target.url}${urlPath}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), pool.requestTimeoutMs);

    // Filter hop-by-hop headers
    const forwardHeaders = new Headers();
    for (const [key, val] of req.headers.entries()) {
      if (
        !key.startsWith("host") &&
        !key.startsWith("connection") &&
        !key.startsWith("keep-alive")
      ) {
        forwardHeaders.set(key, val);
      }
    }

    // Decorate proxy tracking headers
    forwardHeaders.set("X-Forwarded-For", req.headers.get("x-forwarded-for") || "127.0.0.1");
    forwardHeaders.set("X-Forwarded-Proto", "http");
    forwardHeaders.set("X-Request-Id", requestId);
    forwardHeaders.set("X-Upstream-Backend", target.url);

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const bodyData = hasBody ? await req.arrayBuffer() : undefined;

    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: bodyData,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const resBody = await upstreamRes.arrayBuffer();
    const resHeaders = new Headers(upstreamRes.headers);

    // Decorate response headers
    resHeaders.set("X-Request-Id", requestId);
    resHeaders.set("X-Served-By-Backend", target.url);
    resHeaders.set("X-Load-Balancer-Algo", pool.algorithm);

    return new Response(resBody, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Upstream connection failed";
    return new Response(
      JSON.stringify({
        error: "gateway_timeout_or_error",
        message,
        upstream: target.url,
        code: 504,
      }),
      {
        status: 504,
        headers: { "Content-Type": "application/json" },
      },
    );
  } finally {
    // Decrement active connections
    target.activeConnections = Math.max(0, target.activeConnections - 1);
  }
}
