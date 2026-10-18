# R8 Self-Hosted Operations

This runbook describes the reproducible single-host deployment surface. It is local operational
evidence, not a claim that the R8 release gate, external CI, or two-month dogfood gate has passed.

## Secrets and first start

Copy `.env.example` to `.env`, retain the loopback port binding, and create the three files named by
the example. Secret files must not be committed. Use a URL-safe random PostgreSQL password, a
base64url cursor signing key of at least 32 random bytes, and an independent 32-byte base64url backup
key. Make each file readable only by its owner.

```sh
install -d -m 0700 secrets
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > secrets/postgres-password
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > secrets/cursor-signing-key
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > secrets/backup-encryption-key
chmod 0600 secrets/*
docker compose config --quiet
docker compose build --pull
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d app
curl --fail http://127.0.0.1:3001/health
```

PostgreSQL is not published to the host. The application binds to `127.0.0.1` by default. Put a
TLS-terminating reverse proxy on the same host when remote access is required.

The automation worker starts only after the migration service succeeds. It receives only the
machine database secret: no human bearer credential, cursor signing key, backup key, or integration
credential is mounted. `AFW_AUTOMATION_BATCH_LIMIT` and `AFW_AUTOMATION_POLL_MS` bound each cycle and
its polling interval.

## Backup, scheduling, retention, and PITR

The `operations` profile runs a scheduled logical backup. New CLI-created artifacts are encrypted
and authenticated with AES-256-GCM before they enter the backup volume. The key comes from a secret
file or environment variable and never from a command-line argument. Legacy two-file plaintext
artifacts remain readable for recovery compatibility, but operators must not create new plaintext
artifacts for durable storage.

```sh
docker compose --profile operations up -d backup
docker compose --profile operations logs backup
```

Set `AFW_BACKUP_INTERVAL_SECONDS` for scheduling. After each successful backup, the scheduler applies
`AFW_BACKUP_MAXIMUM_AGE_DAYS` while preserving at least `AFW_BACKUP_MINIMUM_RETAINED` authenticated
artifacts. The same policy can be inspected without deletion by running the backup `retention`
command with `--mode dry-run`. Copy encrypted artifacts and WAL segments to independent versioned
storage, apply an equivalent lifecycle there, and keep at least one verified artifact outside the
database host.

PostgreSQL continuous archiving is enabled and writes WAL segments to the dedicated
`postgres_wal_archive` volume with a five-minute archive timeout. The archive command refuses new
copies when free space falls below `AFW_WAL_ARCHIVE_MIN_FREE_KB`; it emits an alert and leaves WAL
retained by PostgreSQL rather than deleting segments without a verified base backup. If capacity is
not restored, PostgreSQL eventually stops writes as its retained WAL fills. A same-host volume is
bounded staging, not a disaster-recovery boundary or PITR proof. Ship the archive to independently
acknowledged encrypted storage and record the base backup/WAL restore procedure before claiming PITR.

## Upgrade checkpoint and rollback

Never let application startup mutate the schema. The one-shot `migrate` service runs after database
health and the `app` service starts only after migration succeeds.

1. Record the running image digest and migration ledger.
2. Create and externally copy a verified encrypted backup.
3. Run a restore rehearsal into a separately created empty database.
4. Pull or build the release image, then run `docker compose run --rm migrate`.
5. Start the app and exercise authenticated reads and writes.
6. If migration or smoke testing fails, stop the app and restore the pre-upgrade artifact into a new
   empty database. Do not reverse additive migrations in place.

Restore requires `RESTORE_DATABASE_URL`, the encryption key, an explicit empty database name, and a
new private report path. Authenticated encrypted artifacts are eligible for activation after all
restore checks pass. Legacy plaintext artifacts restore for recovery compatibility but default to
`activationAllowed: false`; permitting their activation additionally requires the exact operator
acknowledgement `I_ACCEPT_UNAUTHENTICATED_ARTIFACT`. Only a report with `activationAllowed: true`
permits cutover. Every restored credential and lease is quarantined; issue new operator credentials
and explicitly reactivate integrations after inspection.

## Verification and known open gates

Run `npm run check`, the PostgreSQL suites against PostgreSQL 17, `npm run test:backup`,
`docker compose config --quiet`, and an actual encrypted backup/restore rehearsal for each release
candidate. The following remain non-blocking recorded gaps rather than inferred passes:

- hosted CI and release-signing evidence;
- independent object-storage lifecycle and off-host WAL shipping;
- a measured recovery-point/recovery-time exercise after infrastructure failure;
- the required two-month 5-20-person dogfood period; and
- production normal-load, accessibility, and threat-review exit evidence owned by the full R8 gate.
