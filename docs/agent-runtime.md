# Part Workspace Runtime

## Scope and prerequisites

This is a trusted local CLI/embedded host and ACP stdio adapter, not completion of R6.
It uses exactly pinned `@slop-lab/part`, `@slop-lab/part-plugins`, and
`@slop-lab/part-node` version `0.1.0`. These APIs are experimental.
Use Node.js **24.22.0 or newer** and run `npm ci`.

The runtime reuses the authenticated R4 HTTP API and its existing credential authority.
It does not mint Run-scoped credentials or implement durable Runs, leases, generations,
progressive retrieval receipts, or independent agent identity. Do not give this process
administrator credentials or expose its stdio to an untrusted client.

## Local commands

```sh
npm run agent -- help
npm run agent -- tools
npm run agent -- demo
npm run test:agent
```

`demo` uses Part's deterministic local fake model. It makes no provider or Workspace requests.
`tools` prints the static read-only catalog and JSON input schemas without credentials.
`run` emits newline-delimited start, event, and terminal outcome records to stdout;
diagnostics go to stderr. SIGINT and SIGTERM request cooperative cancellation.

Configure the host through environment variables, not model arguments:

| Variable | Meaning |
| --- | --- |
| `AFW_API_URL` | Fixed HTTPS origin, or loopback HTTP origin such as `http://127.0.0.1:3001`. No path, credentials, query, or fragment. |
| `AFW_WORKSPACE_ID` | Workspace selected by the operator. |
| `AFW_AGENT_TOKEN` | Existing bearer credential with only the required R4 permissions. |
| `PART_PROVIDER` | `chat` for OpenAI-compatible Chat Completions or `responses` for the Responses adapter. |
| `PART_MODEL` | Provider model identifier. |
| `PART_MODEL_URL` | Full provider endpoint URL. |
| `PART_API_KEY` | Provider credential. |

Load credentials through your process supervisor or secret manager. Never put tokens in prompts,
URLs, source control, or captured command output. Workspace credentials remain inside host
closures and are not part of tool schemas. Provider credentials are separate.

```sh
npm run agent -- run 'List the visible spaces.'
npm run agent -- tools --allow-action comment.create
npm run agent -- run 'Add the requested comment after reading the item.' --allow-action comment.create
node app/agent-runtime.mjs acp
```

Writes are absent unless an exact command action is supplied with `--allow-action`, repeated
as needed. There is no blanket write flag. Both `space.access` and `entity.access` are always
forbidden. The server still enforces the credential's membership, permission, entity ACL,
revision, and command idempotency rules. An allowlist cannot grant server authority.

## Tools and resource limits

Fourteen default tools expose bootstrap, visible Spaces, Space configuration, Project and Work
Item detail, entity comments/relations/history, Saved Views, Project and Work queries, boards,
paged lexical search, and explicit query-snapshot release. Inputs and read outputs use the
existing R4 Zod contracts. Writes use the canonical command payload schemas with strict
actor-free envelopes and operation-derived idempotency keys. Write tools are classified as
non-retryable: a repeated logical call is not guaranteed to reuse the same command identity.
After an uncertain write outcome, inspect server state before deciding whether to submit again.

HTTP calls have no automatic retries and do not follow redirects. Default timeout is 15 seconds
and maximum response size is 2 MiB. Model inputs cannot select API origins, credentials, or
arbitrary paths. Query snapshots captured by a bundle are released when it closes. Cleanup is
bounded to four concurrent releases and one shutdown deadline. Incomplete cleanup produces a
failed terminal record and nonzero CLI exit; server snapshot expiry remains the final safety bound.
Do not treat a cancelled or failed write as proof that the server applied nothing.

The CLI bounds runs to eight model invocations, sixteen tool dispatches, and a 180-second
deadline. ACP applies the same model/tool budgets, limits connections to sixteen sessions with
thirty-two history turns per session, and requests client permission for writes in addition
to the host action allowlist. ACP stdout belongs exclusively to the protocol. No shell,
filesystem, arbitrary HTTP, or MCP execution tools are installed.
Launch ACP directly with `node`, or use `npm run --silent agent -- acp`; npm's ordinary
script banners would otherwise contaminate the protocol stream.

## Verification and limitations

`npm run test:agent` exercises the real Part SDK with deterministic models, localhost HTTP
fixtures, strict input/allowlist checks, redirect and size/timeout rejection, cancellation,
snapshot cleanup, and ACP write permission decisions. It also runs as part of `npm test` and
`npm run check`. These local tests do not prove compatibility
with every hosted provider or establish production operational readiness.

The full planned protocol remains in [agent-protocol.md](agent-protocol.md). This adapter
deliberately does not advertise Human API responses as progressive agent retrieval envelopes.
