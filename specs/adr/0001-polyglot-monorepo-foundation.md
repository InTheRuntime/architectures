# [ADR-0001] Polyglot Monorepo Foundation & Toolchain Standards

- **Status**: Accepted
- **Date**: 2026-11-22
- **Authors**: InTheRuntime Team
- **Deciders**: Repository Maintainers

---

## Context and Problem Statement

The `architectures` repository requires a maintainable, high-performance monorepo foundation to host heterogeneous systems spanning high-concurrency networking engines (in Rust) and expressive control planes / client libraries (in TypeScript). 

We need a unified workspace toolchain that avoids toolchain friction, provides lightning-fast build and lint execution, and establishes clear module boundaries.

---

## Decision Drivers

1. **Polyglot Harmony**: Seamless developer experience across Rust and TypeScript without siloed tooling.
2. **Deterministic Task Caching**: Rebuilding or re-checking only code affected by a change.
3. **Low CI Overhead**: Minimal lint and formatting execution time.
4. **Consistent Scoping**: Clear namespace isolation preventing naming collisions.

---

## Decision Outcome

Chosen approach:
1. **Workspace Structure**: Root `pnpm-workspace.yaml` paired with a root `Cargo.toml` virtual workspace.
2. **Build Orchestration**: **Turborepo** (`turbo.json`) coordinating npm pipelines and invoking Cargo checks and clippy.
3. **Code Quality**: **Biome** for fast unified linting and formatting of TypeScript, JavaScript, and JSON; `rustfmt` and `clippy` for Rust crates.
4. **Namespacing**: `@intheruntime/*` npm package scope and `itr-*` Cargo crate prefix.
5. **Blueprint Standard**: Language-agnostic specifications housed in `specs/` (ADRs, Protobuf contracts, Mermaid diagrams) required prior to implementation.

---

## Consequences

### Positive
- Sub-second linting and formatting across all JavaScript/TypeScript and JSON files via Biome.
- Cross-language workspace pipelines managed by Turborepo with shared caching.
- Enforced architectural rigor via the "Specs before implementation" workflow.

### Trade-offs & Mitigations
- Managing dual dependency trees (Node `node_modules` vs Cargo `target/`).
- *Mitigation*: Root `.gitignore` and `docker-compose.yml` provide strict isolation of transient artifacts.
