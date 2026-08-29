# ADR 0001: Monorepo boundaries

- Status: Accepted
- Date: 2026-08-26

## Decision

Use one pnpm workspace with `apps/agent`, `apps/desktop`, `packages/contracts`, `packages/config`, and `packages/test-kit`. Keep the Flutter application at `apps/mobile` beside the Node workspace.

The Agent is the state and orchestration authority. Desktop and Mobile consume explicit interfaces and must not call databases, Flutter CLI, or project files directly.

## Consequences

- TypeScript contracts and protocol fixtures can be reused without coupling UI modules to Agent internals.
- Dart models will be generated from OpenAPI rather than importing TypeScript directly.
- Flutter remains managed by its own package tooling while sharing CI and repository policy.
