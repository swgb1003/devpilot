# ADR 0005: Codex provider boundary

- Status: Proposed; implementation deferred until M7
- Date: 2026-08-26

## Proposed decision

Put Codex behind `AiProvider`. Store credentials through a Windows credential store reference, construct a bounded context manifest, treat project text and logs as untrusted data, and mechanically validate every returned patch.

## Decision still required

- Supported Codex invocation and authentication mechanism
- Cancellation and progress semantics
- User-visible external-data disclosure
- Provider limits, retention, and acceptable-use constraints
