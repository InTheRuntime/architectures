export interface BackendTarget {
  url: string;
  healthy: boolean;
  activeConnections: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastCheckedMs: number | null;
}

export type BalancingAlgorithm = "round-robin" | "least-connections";

export interface LoadBalancerOptions {
  algorithm?: BalancingAlgorithm;
  healthCheckPath?: string;
  healthCheckIntervalMs?: number;
  failureThreshold?: number;
  successThreshold?: number;
  requestTimeoutMs?: number;
}

/**
 * Manages the cluster of upstream backend instances, algorithm selection,
 * and active background health checking.
 */
export class UpstreamPool {
  public algorithm: BalancingAlgorithm;
  public readonly healthCheckPath: string;
  public readonly failureThreshold: number;
  public readonly successThreshold: number;
  public readonly requestTimeoutMs: number;

  private targets: BackendTarget[] = [];
  private roundRobinIndex = 0;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(options: LoadBalancerOptions = {}) {
    this.algorithm = options.algorithm ?? "round-robin";
    this.healthCheckPath = options.healthCheckPath ?? "/health";
    this.failureThreshold = options.failureThreshold ?? 2;
    this.successThreshold = options.successThreshold ?? 2;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;

    if (options.healthCheckIntervalMs && options.healthCheckIntervalMs > 0) {
      this.startHealthCheck(options.healthCheckIntervalMs);
    }
  }

  public addTarget(url: string): void {
    const cleanUrl = url.replace(/\/+$/, "");
    if (this.targets.some((t) => t.url === cleanUrl)) {
      return;
    }
    this.targets.push({
      url: cleanUrl,
      healthy: true,
      activeConnections: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastCheckedMs: null,
    });
  }

  public removeTarget(url: string): boolean {
    const cleanUrl = url.replace(/\/+$/, "");
    const initialLen = this.targets.length;
    this.targets = this.targets.filter((t) => t.url !== cleanUrl);
    return this.targets.length < initialLen;
  }

  public getHealthyTargets(): BackendTarget[] {
    return this.targets.filter((t) => t.healthy);
  }

  public getAllTargets(): BackendTarget[] {
    return [...this.targets];
  }

  /**
   * Selects an upstream backend according to the chosen load balancing algorithm.
   */
  public selectTarget(): BackendTarget | null {
    const healthy = this.getHealthyTargets();
    if (healthy.length === 0) {
      return null;
    }

    if (this.algorithm === "least-connections") {
      return this.selectLeastConnections(healthy);
    }

    return this.selectRoundRobin(healthy);
  }

  private selectRoundRobin(healthy: BackendTarget[]): BackendTarget {
    const target = healthy[this.roundRobinIndex % healthy.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % healthy.length;
    return target;
  }

  private selectLeastConnections(healthy: BackendTarget[]): BackendTarget {
    let minTarget = healthy[0];
    for (let i = 1; i < healthy.length; i++) {
      if (healthy[i].activeConnections < minTarget.activeConnections) {
        minTarget = healthy[i];
      }
    }
    return minTarget;
  }

  /**
   * Performs an active health check round against all registered targets.
   */
  public async probeAll(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      this.targets.map(async (target) => {
        target.lastCheckedMs = now;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000);

          const res = await fetch(`${target.url}${this.healthCheckPath}`, {
            method: "GET",
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (res.ok) {
            target.consecutiveSuccesses++;
            target.consecutiveFailures = 0;
            if (target.consecutiveSuccesses >= this.successThreshold) {
              target.healthy = true;
            }
          } else {
            this.handleProbeFailure(target);
          }
        } catch {
          this.handleProbeFailure(target);
        }
      }),
    );
  }

  private handleProbeFailure(target: BackendTarget): void {
    target.consecutiveFailures++;
    target.consecutiveSuccesses = 0;
    if (target.consecutiveFailures >= this.failureThreshold) {
      target.healthy = false;
    }
  }

  public startHealthCheck(intervalMs = 5000): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => {
      this.probeAll().catch(() => {});
    }, intervalMs).unref();
  }

  public stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}
