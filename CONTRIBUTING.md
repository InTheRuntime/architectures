# Contributing to `architectures`

Every system in this repository serves as both a working reference implementation and an engineering study guide. Contributions should maintain strict architectural clarity, test coverage, and documentation rigor.

---

## 1. Blueprints First

Before implementing a new architecture or major subsystem:

1. Copy [`specs/adr/0000-template.md`](./specs/adr/0000-template.md) to the next sequential number in `specs/adr/` (for example, `0007-my-architecture.md`).
2. Document the core problem, decision drivers, rejected alternatives, mathematical sizing or complexity bounds, and failure modes.
3. If the system introduces cross-service RPCs or shared schemas, define them in `specs/contracts/` and validate with `pnpm buf:lint`.
4. Add sequence or topology diagrams using native Mermaid blocks in `specs/diagrams/` or the module's `DESIGN.md`.

---

## 2. Standard Module Layout

- **Runnable Services (`services/<name>/`)**:
  - `README.md` — Features, quickstart commands, API/protocol recipes, and telemetry examples.
  - `DESIGN.md` — First-principles problem statement, data flow, failure modes, and scaling trade-offs.
  - `src/` and `test/` — Clean TypeScript (or Rust) source with isolated automated tests.
- **Libraries (`packages/<name>/` and `crates/<name>/`)**:
  - `README.md` — Public API surface, complexity guarantees, and usage examples.
  - `DESIGN.md` (where non-trivial binary formats or algorithms exist) — Internals specification.
  - `src/` and tests — Self-contained tests without external runtime requirements where practical.

---

## 3. Documentation Style Rules

- **No Emojis**: Keep all prose, headings, commit messages, logs, and diagrams strictly emoji-free.
- **Truthful Metrics & Status**: Never document planned packages, services, or endpoints as implemented. Mark planned items explicitly as `Planned` or `Draft`.
- **Reproducible Examples**: Keep CLI commands, configuration keys, and payloads aligned with the actual codebase.

---

## 4. Verification Checklist

Run all quality gates from the repository root before opening a pull request:

```bash
# TypeScript formatting, linting, and type checking
pnpm format
pnpm lint
pnpm check

# Rust formatting and strict Clippy lints
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

# Full polyglot test suite (Turborepo + Cargo)
pnpm test
```
