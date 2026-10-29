# AKB integration handoff and local evidence

Implementation branch: `feat/work-hub-knowledge-flow`, based on imported public AKB commit
`eeed623fd877d3bbd15c6117513db979b85c41a1`. Changes are submitted through the managed origin;
merge, protected configuration review, CI acceptance, and deployment remain root/operator-owned.

## Running workspace

- Authenticated same-origin R4 service: `http://127.0.0.1:3001`.
- Verified external UI: `https://akb--akb-app.mj-y.com/`.
- DIM route ID: `9502ffad-d4ce-4638-a9c9-fc4aba89ba6a`, approval `not-required`.
- External UI returned HTTP 200; unauthenticated content API returned HTTP 401.
- DIM service name: `akb-app`; inspect with `dim-workspace service list`.
- Private service log: `~/.local/state/dim/services/akb-app.log`.
- Private development credentials: `/workspace/main/secrets/dev-principals.json`, mode 0600,
  separate author, reviewer, and read-context/submit-proposal connector. Credentials expire after
  24 hours; renew intentionally using the admin CLI, not URLs or browser persistence.
- Private DB/signing state: ignored `secrets/postgres-password`, `secrets/cursor-signing-key`, and
  `secrets/backup-encryption-key`. Database and WAL data remain in the workspace-owned Compose volumes.
- Actual DIM allocation was verified as 8 CPU, 32 GiB, and 8192 PIDs. No host control socket,
  operator credential, other workspace, or production service was obtained or changed.

Use [local-development.md](local-development.md) for the fresh-clone sequence, exact Node
`26.12.1`, PostgreSQL `17.6`, and ignored local Blocks commit
`df6f800828cd58acd2af65c32e7341609601be89`. The real entrypoint is `npm run start:r4`, not the
historical unauthenticated `npm start` demo. `node script/start-local.mjs` supplies private local
configuration to that same real server. `node script/dev-principals.mjs` creates the scoped
development identities once and preserves existing state on rerun.

Those npm spellings and the validation commands below are preserved as evidence for this historical
branch. Current operators use the pnpm commands in [local-development.md](local-development.md).

## What was actually exercised

The live AKB acceptance used real PostgreSQL and separate author/reviewer browser contexts:

1. Create a Page in the real Blocks editor, edit text, and save revision 2.
2. Mutate the latest Page to revision 3 and still retrieve the original text by exact revision 2.
3. Submit a Knowledge proposal as the narrow connector, with the exact Page revision and captured
   external result provenance. Submission does not create accepted Knowledge.
4. Replay the identical submission successfully; reject a stale Page edit with HTTP 409.
5. Deny a connector attempt to accept its own result with HTTP 403.
6. Discover the durable inbox as a distinct human reviewer, inspect the candidate and provenance,
   and explicitly accept it.
7. Read immutable accepted Knowledge with the identical Page revision and external result version.
8. Revoke connector `content.read` while preserving its other grants: both the Page and derived
   Knowledge context become unavailable with HTTP 404. Restore the original full grant set.
9. Reject a wrong-workspace read with HTTP 404. Login/reload preserves qualified targets and exact
   revisions; malformed revisions do not silently load latest.

The Work Hub identifiers and permalinks used in these tests are **synthetic fixtures**. This is
real AKB persistence/authentication/browser evidence, not a completed real two-service integration.
No fake AKB Work Item or Run was created to stand in for Work Hub authority.

`test/browser/work-hub-flow.spec.ts` covers the browser narrative and a separately named
**simulated** transport outage using Playwright route abortion. The outage check verifies an
explicit UI error; it is not proof of Work Hub connector retry/recovery. A separate live DB test
accepts different Knowledge v1 and v2 candidates/provenance and confirms exact v1 remains unchanged.

Responsive captures cover Pages, Proposal detail, and Knowledge detail at 375, 768, and 1280 px.
Long identifiers are checked against detail-card bounds, and screenshots settle transitions.
The acceptance reported no browser runtime errors. Local screenshots and sanitized results are in
ignored `.omo/evidence/akb-work-hub/` and `test-results/manual-integration/`.

## Validation commands and boundaries

- `npm run check`: formatting, lint, backend TypeScript, unit/integration/agent/feature tests.
- `npm run web:typecheck`, `npm run web:test`, `npm run web:build`.
- Five focused real-browser scenarios passed through the verified external HTTPS route, covering
  the complete flow, invalid credentials, deterministic login-focus ordering, independent
  inbox/detail error ordering, and the explicitly simulated transport outage. The web unit suite
  passed nine tests. Existing unrelated browser scenarios were updated for native link navigation,
  but their full historical fixture-dependent suite is not claimed as rerun here.
- `npm run test:features:postgres`: real isolated PostgreSQL feature schemas, including proposal
  replay, changed-command conflicts, stale acceptance, source revocation, wrong workspace, and
  historical Knowledge after a later acceptance: 47 tests passed.
- `node script/generate-api-r4.mjs --check`: current generated contract consistency. Legacy
  `docs/openapi.json` and migrations 001-016 remain byte-preserved.
- `npm audit`: zero advisories after targeted Zod/undici/fast-uri updates. The legacy UTC timestamp
  input range is explicitly preserved and tested despite Zod's changed default datetime precision.
- `docker compose build app`: fresh ignored Blocks clone/build occurs inside the image.
- Compose application smoke: real health HTTP 200 and unauthenticated API HTTP 401.
- PostgreSQL 17 backup/restore gate: 28 tests passed using the application image's real PG17 tools.

The editor's canonical format remains unmarked text. Marked or non-text inline changes are
explicitly rejected, not silently flattened. Rich-inline persistence is not claimed.

TypeScript/Biome language-server binaries were unavailable and installation had not been requested;
native `tsc` and Biome commands were used instead. Independent final model review could not be
completed after the existing UI child route denied `openai/gpt-5.6-sol` on the Responses path;
no repeated authorization probes or agent configuration changes were made. No independent-review
or Lighthouse score is claimed.

## Root and Work Hub next steps

1. Read [work-hub-integration.md](work-hub-integration.md) and its owning Zod schemas in
   `src/contracts/content/` and `src/contracts/knowledge/`. Configure explicit installation,
   workspace, and project mappings, not title matching.
2. Supply a separately scoped service principal to the real Work Hub adapter through its trusted
   credential boundary. Grant only `content.read`, `knowledge.read`, and `knowledge.propose`.
   Never reuse the development author/reviewer token or grant automatic acceptance/delegation.
3. Coordinate remote-main-4's actual Work Hub adapter against the verified AKB origin. Repeat the
   immutable task-context/result-proposal/human-review flow with real task/attempt/result IDs, then
   test real connector outage recovery using the same logical idempotency key.
4. Complete normal DIM CI and human review. The obsolete `.dim/` launch/archive source removal and
   CI runtime pin require the ordinary protected-change process. Confirm no active project manifest
   still references those retired entrypoints and preserve any retained archive obligations before
   merge. This proposal never invokes them or changes a live workspace lifecycle.
