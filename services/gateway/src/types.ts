export interface GatewayRoute {
  id: string;
  pathPrefix: string;
  upstreams: string[];
  rateLimit: {
    capacity: number;
    refillRate: number;
  };
  auth: {
    required: boolean;
    requiredMask: bigint;
  };
  cache: {
    enabled: boolean;
    ttlMs: number;
  };
}

export interface GatewayStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  rateLimitedRequests: number;
  authRejectedRequests: number;
  activeRoutes: number;
}
