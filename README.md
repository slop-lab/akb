# Agent-First Workspace

This repository is the greenfield home for a planned self-hostable collaboration,
knowledge, and small-project management system designed for people and software agents
working in the same typed, revisioned graph.

## Current Status

The product is **not implemented yet**. The repository currently contains:

- the canonical English v1 design specification;
- a minimal Node.js HTTP bootstrap at [`app/server.mjs`](app/server.mjs); and
- preserved Dev Infra Manager (DIM) environment infrastructure under [`.dim/`](.dim/).

The bootstrap server only returns a plain-text sample response. It is not the planned API,
web application, worker, retrieval layer, runtime protocol, or any other product feature.
Future product code is expected to use strict TypeScript; the existing `.mjs` file is only
the current environment entrypoint and does not establish the application architecture.

## Documentation

- [`agent-first-workspace-v1-design.md`](agent-first-workspace-v1-design.md) is the canonical
  product and engineering design baseline. It defines planned contracts, invariants, scope,
  phase gates, Definition of Done, backlog, risks, and the first vertical slice. Statements in
  that document describe requirements and decisions, not completed functionality.
- [`docs/product-and-domain.md`](docs/product-and-domain.md) summarizes the intended product and
  domain boundaries.
- [`docs/roadmap.md`](docs/roadmap.md) defines dependency-ordered delivery phases and exit gates.
- [`docs/implementation-status.md`](docs/implementation-status.md) maps every canonical design
  section to its current evidence-based delivery status.
- [`docs/architecture.md`](docs/architecture.md),
  [`docs/agent-protocol.md`](docs/agent-protocol.md), and
  [`docs/security-and-quality.md`](docs/security-and-quality.md) define the engineering contracts
  that future implementation must satisfy.
- [`docs/adr/README.md`](docs/adr/README.md) records proposed architecture decisions separately
  from accepted bootstrap constraints.
- This README describes only the repository as it exists now and is the source of truth for
  its bootstrap status.

## Entrypoints and Environment

The current application entrypoint is:

```sh
node app/server.mjs
```

It listens on `0.0.0.0:3000`. DIM starts that command through
[`.dim/agent/start.sh`](.dim/agent/start.sh). The DIM Compose environment mounts this repository
at `/workspace`, runs the agent container as the workspace owner, and provides a private Docker
sidecar; see [`.dim/docker-compose.yml`](.dim/docker-compose.yml).

The [public DIM upstream mirror](https://github.com/slop-lab/dev-infra-manager) documents the
external infrastructure manager and its environment model. In this repository, `.dim/` is the
only DIM-specific project infrastructure. It is intentionally preserved and is not application
source, a product module, or evidence that the planned system has been implemented. Product
development should replace the sample application entrypoint as the architecture is established,
without treating `.dim/` as code to migrate or redesign.
