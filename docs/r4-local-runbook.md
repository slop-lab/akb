# Local R4 Runbook

## Scope and evidence boundary

This runbook starts the locally implemented R3/R4 application. It does not pass a roadmap phase or
CI. A recorded native Node 24 live run returned `200` for archived-inclusive export (44,441 NDJSON
bytes) and Project query (8,699 response bytes), completed export/import/replay/re-export with `200`
responses, rejected malformed import with `400`, returned `200` for archive/restore queries, and
released snapshots with `204`. The real-browser suite passed all 10 scenarios in 23.7 seconds with
no mocks or skips. These results are bounded evidence, not a formal gate promotion.

## Requirements

- Node.js 24 and npm with the committed lockfile.
- PostgreSQL 17 for the application database.
- PostgreSQL 17 `pg_dump` and `pg_restore` for backup rehearsal.
- A same-origin deployment for the built web application and API.

Install exactly the locked dependencies and migrate the target database:

```sh
npm ci
DATABASE_URL='postgres://operator@host/workspace' npm run migrate:postgres
```

## Bootstrap identity and grants

Bootstrap prints a bearer token once. Capture it in an operator-controlled secret channel; do not
write it into the repository, command history, URLs, browser storage, fixtures, or documentation.

```sh
DATABASE_URL='postgres://operator@host/workspace' npm run admin -- bootstrap-workspace \
  --workspace-id example --workspace-name "Example" \
  --principal-id admin --principal-name "Example Admin"

DATABASE_URL='postgres://operator@host/workspace' npm run admin -- grant-r4-permissions \
  --workspace-id example --principal-id admin
```

For an operator-created private Space, add explicit Space grants. Workspace role and Project
participation do not bypass private-Space ACL.

```sh
DATABASE_URL='postgres://operator@host/workspace' npm run admin -- create-space \
  --workspace-id example --space-id private --space-name "Private" --visibility private

DATABASE_URL='postgres://operator@host/workspace' npm run admin -- set-space-permissions \
  --workspace-id example --space-id private --principal-id admin \
  --permissions work.read,work.create,work.update,work.assign,space.read,space.manage,project.read,project.manage,comment.create,comment.update,relation.manage,view.read,view.manage,history.read,acl.manage
```

`grant-r4-permissions` is additive for an existing member. Migrations and recovery never widen old
membership grants automatically.

## Cursor/import signing secret

Generate at least 32 random bytes encoded as base64url outside the repository. The following keeps
the value in the current shell only:

```sh
R4_CURSOR_SIGNING_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export R4_CURSOR_SIGNING_KEY
```

Do not publish a sample production value. The same server-side key signs Human Query/search cursors
and import validation tokens; it is never sent to browser code or stored in application tables.

## Build and start

```sh
npm run build:r4
DATABASE_URL='postgres://operator@host/workspace' \
R4_CURSOR_SIGNING_KEY="$R4_CURSOR_SIGNING_KEY" \
npm run start:r4
```

The R4 application defaults to `127.0.0.1:3001`. It serves `apps/web/dist` and the API from the same
origin. Override `HOST`, `PORT`, or `WEB_ASSETS_DIR` only through deployment configuration.

The historical `npm start` entrypoint remains the unauthenticated process-local demo on port 3000.
It is not upgraded or redirected by this runbook. `.dim/` remains preserved development
infrastructure and is not application source.

## Named local gates

```sh
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run test:postgres
npm run test:r4
npm run test:commands
npm run test:backup
node --test build/test/r4-route-inventory.test.js
node script/generate-api-r4.mjs --check
```

Database suites require `DATABASE_URL` and do not count as passed when unavailable. The backup suite
also requires PostgreSQL 17 tools and disposable database-creation authority. The latest evidence
ran the relevant PostgreSQL R4 and public 100,000-item scale tests individually, not the aggregate
`npm run test:r4` command. Do not infer a formal phase or CI result from build output, an individual
test, or this runbook.
