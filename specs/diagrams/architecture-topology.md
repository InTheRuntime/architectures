# System Architecture Topology

This document describes the overall system architecture topology for the `architectures` monorepo core infrastructure, illustrating the boundary separation between high-performance edge components and control planes.

---

## Topology Architecture

```mermaid
graph TD
    Client["Client Applications<br/>(Browsers, Mobile, CLI, Third-Party)"]

    subgraph Edge ["Edge Network Ingress Layer"]
        DataPlane["Rust API Gateway Data Plane<br/>(itr-gateway-data-plane: Axum / Tokio)"]
        AtomicCache[("Lock-Free Route Table<br/>ArcSwap in Memory")]
        LocalRateLimit["In-Memory Token Bucket<br/>(Fallback Engine)"]
    end

    subgraph ControlPlaneLayer ["Control & Management Layer"]
        ControlPlane["TypeScript Control Plane<br/>(@intheruntime/gateway-control-plane: Hono)"]
        Drizzle["Drizzle ORM"]
        AdminDashboard["Admin API & CLI"]
    end

    subgraph StateStorage ["Shared Infrastructure & State"]
        Postgres[("PostgreSQL 16<br/>Routes, Tenants, Keys, Audit")]
        RedisState[("Redis 7<br/>Distributed Rate Limiter & Pub/Sub")]
    end

    subgraph UpstreamServices ["Upstream Target Services"]
        ServiceA["Auth & Identity Service"]
        ServiceB["Core Business APIs"]
        ServiceMock["Mock Upstream / Echo"]
    end

    %% Ingress Flow
    Client -->|"HTTP/1.1 & HTTP/2 Requests"| DataPlane

    %% Data Plane Hot Path
    DataPlane -->|"1. Lock-free route lookup"| AtomicCache
    DataPlane -->|"2. Token evaluation (atomic Lua)"| RedisState
    DataPlane -.->|"Fallback if Redis down"| LocalRateLimit
    DataPlane -->|"3. Zero-DB Bitwise RBAC verification"| DataPlane
    DataPlane -->|"4. Proxied request"| UpstreamServices

    %% Management Flow
    AdminDashboard -->|"Admin CRUD & Config"| ControlPlane
    ControlPlane -->|"Persist metadata"| Drizzle
    Drizzle --> Postgres

    %% State Synchronization Flow
    ControlPlane -->|"Publish invalidation event"| RedisState
    RedisState -->|"Pub/Sub notification"| DataPlane
    DataPlane -.->|"Cold boot snapshot sync"| ControlPlane
```

---

## Component Responsibilities

| Component | Technology | Primary Responsibility |
| :--- | :--- | :--- |
| **Data Plane** | Rust, Axum, Tokio, Tower | Sub-millisecond reverse proxying, connection pooling, zero-database hot path JWT/key authorization, and token-bucket rate limiting. |
| **Control Plane** | TypeScript, Hono, Drizzle | Administrative route CRUD, tenant lifecycle, role-to-bitmask mapping, API key generation, and schema validation. |
| **PostgreSQL** | PostgreSQL 16 | Durable relational system of record for routes, tenants, permissions, and audit logs. |
| **Redis** | Redis 7 | Atomic distributed token bucket state via preloaded Lua scripts, and Pub/Sub channel for instantaneous cache invalidation. |
| **Mock Upstream** | Docker HTTP Echo | Reliable verification target during local testing and automated E2E suites. |
