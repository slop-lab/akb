# R1/R2 Verification and CI Deferral

## Evidence Scope

The candidate at commit `90401bd025025ece0f89b2b1056352f509628cca` is published on
`r1-r2-ci-evidence`. It contains executable evidence for the bounded, process-local
Work Item slice, not the full v1 product or durable concurrency.

- [HTTP lifecycle and idempotency](../test/work-item-http.test.ts).
- [Same-process concurrent PATCH](../test/work-item-concurrency-http.test.ts):
  two requests with one base revision produce one success and one conflict,
  retaining the winning update at revision 2.
- [Observed HTTP error examples](../test/openapi-examples.test.ts) match the
  [OpenAPI contract](openapi.json), including admission failures and internal errors.
- [Restart behavior](../test/work-item-list-restart.test.ts) confirms data loss;
  persistence is explicitly deferred.
- [Quality workflow](../.gitea/workflows/quality.yaml) uses read-only token
  permissions, a digest-pinned Node image, and full dependency audit. It does not
  execute pull-request events.

The preceding verification session observed 25 unit and 38 integration tests
passing, along with formatting, lint, strict compilation, build, and dependency
audit. The same command sequence passed in a detached clean checkout and in the
pinned Node container. These are local results, not Gitea Actions success.

## Outstanding CI Gate

Gitea Actions run `24`, job `58`, was created for the candidate push. The latest
observed job status was `queued`, with label `ubuntu-latest` and `runner_id: 0`.
That proves no runner was assigned at observation time; it does not prove that
no runner exists. Runner inventory access returned HTTP 403 because the current
identity is not the repository owner.

The user authorized deferring this infrastructure check if the DIM VM route was
unavailable. CI is therefore **deferred, not passed**. R1 and R2 remain
`In progress`; this exception does not change their exit gates or promote any
canonical section to `Implemented`.

## DIM QEMU Alternative

The inspected `dim-dim/root` revision was
`f2808365b761f569667e3a7504c491d3caff7d57`. Its `.dim/qemu-client.mjs` uses a
protected host service over a Unix socket rather than launching QEMU inside the
agent container. Host-side KVM can therefore be used without exposing `/dev/kvm`
to the agent.

The supported socket is selected by `DIM_QEMU_VERIFICATION_SOCKET`, defaulting
to `/run/dim/qemu-verification/service.sock`. In this workspace, the selected
socket was absent and `DIM_WORKSPACE_KVM` was unset. The local `.dim/` also did
not contain the QEMU client. No supported service was reachable, so no VM was
launched. Absence of agent-local `/dev/kvm` alone is not the blocker.

The protected VM verification route is not automatically a registered Gitea
Actions runner. Connecting it to this repository would additionally require
an authorized runner deployment and registration. No host service, runner token,
repository protection, or DIM infrastructure was modified.

## Resume and Next Dependency

An authorized operator must supply a suitable runner or connect the protected
DIM service, then verify the exact candidate in Actions before closing R1/R2.
Direct pushes to protected `main` were rejected; the candidate remains on its
review branch and has not been merged.

The next product phase is R3: persistent tenant, identity, event, and ACL
foundations. Under the existing roadmap, exploratory work may proceed while CI
is deferred, but R3 cannot pass before R1/R2 pass. Its first prerequisite is the
persistence/transaction and tenant-isolation contract, followed by PostgreSQL
migrations and a durable adapter. This report does not claim those are implemented.
