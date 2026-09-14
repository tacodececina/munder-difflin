# Phase 5 movement implementation plan

Approved scope: complete phase 5 of Astra, explicitly requested by Alex with GPT-5.6 agents.

Goal: one authority for visual movement, safe transit with progress, and executable async-spawn tests.

Architecture: extend the existing director behind independent default-off `movementCoordinationEnabled`. With both movement and stations enabled, share the same director and reservations. Preserve the published phase-6-only routing behavior. Replace existing pending-spawn tracking with generation-owned lifecycle coordination as a correctness fix.

Tech stack: TypeScript, existing BFS, Pixi Character adapter, node:test; no new dependencies or physics engine.

- Routing worker: stable request priorities, occupied-destination waiting, deterministic yielding, bounded replanning and termination; real-map tests for 11 agents, swaps, crossings, bottlenecks, removal and mid-step cancellation.
- Commands worker: owner/priority arbitration in Character; blocked operational floor persists after arrival; lower-priority commands cannot erase active callbacks. Callback and physical-step lifetimes remain separate.
- Spawn worker: seat ownership, generation identities, deferred textures, removal/re-addition, rejection, teardown and retry tests.
- Root: independent flag/config/locales, shared-director lifetime, every scene movement owner, immediate release of cancelled choreography, operational/breaker precedence, runtime integration tests and verification.

Acceptance: transit tile/edge exclusion and bounded progress; explicit cancellation where no passage exists; permanent seat claims separate from transit reservations; no station or idle choreography supersedes an operational block; no new resources when both flags are off. No changes to operational agent status or dispatch. No new per-frame routing scans.

Validation: red/green focused tests, build, node/web types, lint, full tests, source-mapped coverage with explicit denominator, dependency audit. Preserve unrelated local branding/packaging/daemon edits. Publish only the verified task change to the authorized fork; document limitations without claiming a production soak.
