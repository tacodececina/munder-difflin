# Phase 6: stations from verifiable activity

Approved scope: phase 6 of `astra-plan.md`, explicitly requested by Alex on 2026-09-14.

Goal: optional station visits show observed tool requests and correlated outcomes without changing operational agent status, fabricating execution, or replaying short calls.

Architecture: additive hook metadata, one shared tool taxonomy, event-driven station director, and optional shared movement reservations. No per-frame station scan. All resources are constructed behind a default-off flag. Parser evidence is secondary and cannot initiate travel. Native request evidence also remains labelled as a request until a real outcome arrives.

Parallel ownership:

1. Hooks worker: real timestamps and IDs, request/denial/completion/failure classification, proxy provenance, executable contract and runtime tests.
2. Movement worker: current/next/destination/edge reservations, optional Character attachment, cancellation preserving the in-flight step, unreachable/arrival outcomes, pure tests.
3. Themes worker: optional authored station stands, collision validation, real office positions, legacy noninheritance, bundle/generator tests.
4. Root: shared mapping, station director and evidence arbitration tests, feature flag and four locales, scene lifecycle integration and validation.

Acceptance: immediate labelled observation; sustained correlatable request may travel only to a reachable authored stand; outcome/denial/breaker/session change/disconnect/disable cancels. Ambiguous concurrency and stale observations cannot trigger travel. No inherited office coordinates, write controls, task-completion claims, or invented errand durations. Character stays in a stable idle pose at a station.

Phase 5 dependency is limited to a shared reservation authority needed for safe station travel. Full coordinated priority/yield scheduling of every legacy choreography is not claimed by this phase. Optional travel may cancel when blocked.

Validation: focused executable tests, build, node/web typecheck, existing lint, full suite, dependency audit. Record preexisting failures and coverage limitations explicitly. Do not include unrelated branding or remote-daemon work in the change.
