# Local development

This is the supported fresh-clone setup for the authenticated R4 application. It keeps Blocks and
all credentials in ignored local paths. It does not use a host control socket or place bearer
tokens in URLs.

## Exact inputs

- Node.js `26.12.1` (`.node-version`; npm `11.20.0` is bundled). Docker uses the exact
  multi-platform image digest recorded in `Dockerfile`.
- PostgreSQL `17.6` in Compose and PostgreSQL 17 clients in the application image, both using the
  exact recorded multi-platform image digest.
- Blocks commit `df6f800828cd58acd2af65c32e7341609601be89` under ignored `.deps/blocks`.
- pnpm `10.17.1`, invoked ephemerally by `npm exec`; no global install is required.

The Blocks repository is not an npm dependency, tracked vendor tree, or submodule. Do not modify it
for AKB-only work.

## Initialize ignored local state

Select Node 26.12.1 with the version manager that reads `.node-version`, then verify it:

```sh
node --version
node script/bootstrap-local.mjs
```

On an Alpine/musl DIM guest without a system `libatomic`, install both Node and its runtime library
under the current user's home directory. This does not require root or a protected `.dim` change:

```sh
node_root="$HOME/.local/node-v26.12.1-linux-x64-musl"
library_root="$HOME/.local"
package_root="$HOME/.cache/node26-libatomic"
mkdir -p "$node_root" "$library_root" "$package_root"
curl --fail --location --output "$package_root/node.tar.xz" \
  https://nodejs.org/dist/v26.12.1/node-v26.12.1-linux-x64-musl.tar.xz
printf '%s  %s\n' \
  4fd7c15fdc930ea48cf144bb302ce30a76c81920e36473d087720d0810efe1cd \
  "$package_root/node.tar.xz" | sha256sum --check
tar -xJf "$package_root/node.tar.xz" --strip-components=1 -C "$node_root"
apk fetch --no-cache --output "$package_root" libatomic
set -- "$package_root"/libatomic-*.apk
test "$#" -eq 1
tar -xzf "$1" -C "$library_root"
export PATH="$node_root/bin:$PATH"
export LD_LIBRARY_PATH="$library_root/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
node --version
```

The verified DIM guest paths are therefore `/home/dim/.local/node-v26.12.1-linux-x64-musl/bin`
and `/home/dim/.local/usr/lib`. Persist the two exports in the user's shell profile if this runtime
will be reused. Do not replace system libraries or edit the protected DIM container definition for
an application dependency.

The bootstrap refuses any other Node version. It creates `.env` and mode-0600 secret files under
ignored `secrets/` only when absent; reruns preserve existing files and never print their values.

Install the root lockfile, then prepare Blocks:

```sh
npm ci
npm run setup:blocks
```

`setup:blocks` verifies the GitHub origin, refuses a non-Git or dirty checkout, fetches the exact
commit only when needed, checks it out detached, installs its frozen lockfile without lifecycle
scripts, and explicitly builds its packages. To validate an existing checkout without installing
or changing anything, run `npm run setup:blocks -- --check`.

## Docker Compose: complete local service

The Docker build clones and builds the same ignored Blocks pin inside the build stage. `.deps` is
excluded from the build context and removed before the runtime image, so a developer checkout is
neither copied nor shipped.

```sh
docker compose config
docker compose build app
docker compose up --detach postgres migrate app
docker compose ps
curl --fail http://127.0.0.1:3001/health
```

The application binds to loopback by default. Compose reads credentials through Docker secrets from
the ignored files created above. It does not mount a Docker socket or require operator credentials.
The application, migration, automation, and backup processes run as UID/GID `1000:1000`; in the
supported DIM guest the bootstrap also runs as UID/GID `1000:1000`, so its mode-0600 files are
readable by those containers. Confirm with `stat -c '%u:%g %a %n' secrets/*` before startup when
using a different host ownership model. PostgreSQL's root entrypoint reads its password file before
dropping privileges.
Use `docker compose logs --follow app` for server logs and `docker compose down` to stop services;
add `--volumes` only when intentionally deleting the local database and WAL archive.

Operations-only automation and backup services are optional. Start the backup profile only after
reviewing retention and storage requirements:

```sh
docker compose --profile operations up --detach backup
```

## Native application with local PostgreSQL

Start only PostgreSQL in Compose, then use its secret to form a shell-local database URL. Avoid
putting the value in documentation, process arguments shared with others, or URLs opened by a
browser.

```sh
docker compose up --detach postgres
export DATABASE_URL="postgres://afw:$(cat secrets/postgres-password)@127.0.0.1:5432/afw"
export R4_CURSOR_SIGNING_KEY="$(cat secrets/cursor-signing-key)"
npm run migrate:postgres
npm run build:r4
npm run start:r4
```

The authenticated server and same-origin UI are then at `http://127.0.0.1:3001`. `npm start` is the
historical unauthenticated in-memory demo and is not the supported integrated development server.

### Scoped development principals

After migration, create the local development identities once:

```sh
node script/dev-principals.mjs
```

The script defaults to the ignored PostgreSQL password file and loopback database above, while an
explicit shell-local `DATABASE_URL` takes precedence. It creates workspace `akb-dev` with three
separate principals:

- `akb-dev-owner`: human author with normal work/content management plus knowledge proposal,
  acceptance, and review permissions;
- `akb-dev-reviewer`: human reviewer with read, knowledge acceptance, and review-decision
  permissions but no content-management grant; and
- `akb-dev-work-hub`: service connector limited to content/knowledge read and knowledge proposal.

Credentials expire after 24 hours and are written once to ignored
`secrets/dev-principals.json` with mode `0600`. Rerunning preserves the existing file and does not
rotate or print tokens. Use the administrator CLI for intentional renewal. Never put these tokens
in URLs, tracked configuration, shell tracing, or server logs; read only the one principal needed
by the local client.

### Private persistent launcher

`script/start-local.mjs` reads the ignored PostgreSQL password and cursor-signing key, supplies
loopback defaults only when the corresponding environment variables are absent, changes to the
repository root, and starts the authenticated R4 server in the foreground. Build the UI first:

```sh
npm run build:r4
node script/start-local.mjs
```

For a private unmanaged background process, keep its PID and logs in ignored `secrets/`:

```sh
umask 077
nohup node script/start-local.mjs >>secrets/dev-server.log 2>&1 &
printf '%s\n' "$!" >secrets/dev-server.pid
curl --fail http://127.0.0.1:3001/health
```

Stop only that recorded process with `kill "$(cat secrets/dev-server.pid)"`. Prefer a DIM-managed
development service for persistence across workspace sessions rather than relying on `nohup`.

### Safe DIM development-service registration

DIM owns service lifecycle and external URL approval. The current workspace helpers were exercised
with this registration, after selecting the Node toolchain above:

```sh
dim-workspace service register --name akb-app -- /usr/bin/env \
  PATH="$PATH" LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}" node script/start-local.mjs
dim-workspace service resume
dim-workspace service list
dim-expose list
```

The service supervisor writes private logs to
`~/.local/state/dim/services/akb-app.log`. It does not replace the coding-agent session registration.
Request an external route only after login and unauthenticated API denial are verified:

```sh
dim-expose --name akb-app --port 3001 --ingress shared
```

`shared` is the ingress actually available in this workspace. Use the ingress configured by your
DIM operator elsewhere. Treat the returned approval state as authoritative; a pending request is
not a working URL.

| Field | Safe local value |
|---|---|
| Working directory | `/workspace/main` |
| Command | `node script/start-local.mjs` with the selected toolchain environment above |
| Bind/health | loopback port `3001`, `GET /health` |
| Restart | persistent development service, bounded to this workspace |
| Credentials | existing ignored files under `/workspace/main/secrets`; no operator credential |
| External URL | disabled until authenticated login is verified; request approval through DIM |

The service registration must inherit the verified Node 26 `PATH` and musl `LD_LIBRARY_PATH` from
the workspace runtime. Do not mount a host Docker/controller socket, embed bearer tokens, or use the
legacy `.dim/` privileged agent stack to publish the application. Tokens stay in request headers,
never in the registered URL.

For UI iteration after the backend is running, use `npm run web:dev`. Its Vite server is
`http://127.0.0.1:5173` and proxies API requests to the configured local backend. Keep persisted
application data in PostgreSQL, server logs in the foreground or Compose logs, and generated web
assets in `apps/web/dist`.

## Verification

Lightweight setup checks:

```sh
npm run setup:blocks -- --check
npm run web:typecheck
npm run web:build
docker compose config --quiet
```

Database and backup suites require the corresponding live resources and never count as passing
when unavailable. See the local runbook for the full named gates.

## Obsolete protected DIM removal proposal

The tracked `.dim/` directory describes an older privileged nested-Docker agent workspace and
controller/development-URL proxy. It is not used by the application Dockerfile, `compose.yaml`, or
the setup above. In particular, `.dim/docker-compose.yml` provisions a privileged daemon and
credential-bearing agent environment that should not be copied into application setup.

Repository-internal callers are limited to the `.dim/` scripts themselves and historical
documentation. The current guest also does not expose the controller/development URL socket
environment described by `.dim/setup.sh`, and its Docker endpoint differs from that compose file's
`tcp://agent-dind:2375`. This is evidence that the files are obsolete for the current application
workflow, not proof that an external DIM project registration no longer references them.

Removal belongs in a separate protected configuration change. Before merge, the DIM root owner
must confirm the active project manifest and lifecycle entrypoints do not call `.dim/setup.sh`,
`.dim/entrypoint.sh`, or `.dim/teardown.sh`; decide whether the `agent-home` backup/restore workflow
has any retained data obligation; and complete normal protected configuration review. Do not
self-approve that deletion or combine it with application deployment. The application setup in
this document remains independent of the proposal.
