# [ADR-0002] API Gateway Architecture: Decoupled Data Plane & Control Plane

- **Status**: Accepted
- **Date**: 2026-11-22
- **Authors**: InTheRuntime Team
- **Deciders**: Repository Maintainers

---

## Context and Problem Statement

An API Gateway must handle high-throughput edge network ingress with sub-millisecond overhead while simultaneously exposing dynamic routing, API key lifecycle management, and rate-limiting policies to operators and developers.

Combining high-throughput packet processing with dynamic management APIs in a single monolithic runtime either sacrifices raw networking performance (if purely in Node.js) or slows down rapid administrative schema evolution (if writing complex CRUD/Admin APIs purely in Rust).

---

## Decision Drivers

1. **Hot-Path Performance**: Maximum requests/sec, minimal latency variance, and zero garbage-collection pauses.
2. **Operational Ergonomics**: Rapid evolution of administrative APIs, developer portal integrations, and tenant schemas.
3. **Dynamic Reconfigurability**: Updating routing rules and rate limits without dropping connections or restarting proxy processes.

---

## Decision Outcome

We adopt a **Decoupled Architecture**:

1. **Data Plane (`services/gateway/data-plane` / `itr-gateway-data-plane`)**:
   - Implemented in **Rust** using **Axum**, **Tokio**, and **Tower**.
   - Direct network proxying, TLS termination, zero-database hot-path token verification, and connection pooling.
   - Maintains an atomic, lock-free in-memory route routing table (`arc-swap`).

2. **Control Plane (`services/gateway/control-plane`)**:
   - Implemented in **TypeScript** using **Hono** and **Drizzle ORM** over **PostgreSQL**.
   - Exposes RESTful administration APIs for tenant management, route definitions, and API key provisioning.

3. **State Synchronization**:
   - Real-time updates pushed from Control Plane to Data Plane via **Redis Pub/Sub** cache-invalidation events.
   - Data Plane performs a full state snapshot hydration from the Control Plane on cold boot.

---

## Consequences

### Positive
- Edge proxy achieves native compiled speed, sub-millisecond reverse proxying, and minimal memory usage.
- Control plane benefits from TypeScript's rich ecosystem for API schemas and database migrations.
- Dynamic route changes propagate in near real-time (< 5ms) across all proxy replicas.

### Trade-offs & Mitigations
- Network dependency on Redis for pub/sub event distribution.
- *Mitigation*: If Redis is temporarily unreachable, the Data Plane continues serving traffic using its immutable local in-memory route snapshot.
