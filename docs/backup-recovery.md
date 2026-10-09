# PostgreSQL Backup and Recovery Runbook

## Scope

The operator CLI provides a bounded R3 backup baseline for schema migration 004 on PostgreSQL 17.
It creates one custom-format archive and a same-snapshot semantic manifest, verifies local artifact
integrity offline, and restores only to a pre-created pristine database. It is not PITR, scheduling,
replication, encrypted storage, authenticity signing, or a complete release backup program.

The artifact contains all application data, including credential hashes. File permissions are not
encryption. Treat both artifact files and recovery reports as restricted operational material. A
digest detects accidental changes but does not authenticate an artifact. `pg_restore` executes SQL
from the archive, so restore only artifacts from a trusted operator and source database.

## Requirements

- Node.js 24 and the committed npm dependencies.
- PostgreSQL 17 source and target servers.
- PostgreSQL 17 `pg_dump` and `pg_restore` clients, selected with `PG_DUMP_PATH` and
  `PG_RESTORE_PATH` when they are not on `PATH`.
- A source database with exactly migrations 001 through 004 and the documented public catalog.
- A target database owned by the restore user, encoded UTF-8, created from `template0`, with no
  other sessions or user objects.

Never point restore at an application or worker database. The new target must remain disconnected
from API and worker configuration until the success report says `activationAllowed: true`.

Backup database URLs accept no connection query option except one validated `sslmode`. PostgreSQL
tools receive a reconstructed password-free URI plus `PGPASSWORD`; inherited `PG*` variables are
removed before launch so service files, host addresses, or options cannot redirect the operation.

## Create

Use exactly one source URL. The artifact path must not exist.

```sh
SOURCE_DATABASE_URL='postgres://operator@host/source' \
PG_DUMP_PATH=/path/to/pg_dump \
npm run backup -- create --artifact-dir /restricted/new-backup
```

`DATABASE_URL` is accepted instead of `SOURCE_DATABASE_URL` for existing operator environments,
but configuring both fails closed. The CLI creates a `0700` directory containing only
`archive.dump` and `manifest.json`, both `0600`. The manifest is written last. An interrupted
directory without a valid manifest is not a backup artifact.

Creation holds one read-only repeatable-read exported snapshot while `pg_dump` and all ordered table
COPY digests complete. The dump is awaited before digesting so its process and archive handle have
one owner. Digests force UTC, ISO YMD dates, hex bytea, and UTF-8; text keys use UTF-8 byte ordering
while numeric revision keys retain numeric ordering. This can retain dead tuples, so run it as a
bounded operator action and monitor database capacity.

## Verify

Verification requires no database credentials or connection:

```sh
PG_RESTORE_PATH=/path/to/pg_restore \
npm run backup -- verify --artifact-dir /restricted/new-backup
```

This checks exact paths and modes, strict manifest structure, the trusted local migration catalog,
the pinned schema-004 catalog fingerprint, archive bytes and digest, the bound overall digest, the
PostgreSQL 17 version contract, and `pg_restore --list`. The fingerprint covers public relations,
columns, all type classes, constraints, indexes, rules, triggers, routines and their configuration,
RLS state and policies, sequences, operators and related classes, casts, collations, conversions,
extended statistics, text-search objects, transforms, security labels, extensions, and ownership
semantics without storing OIDs or role names. Projection and validation run in one transaction with
`search_path` fixed to `pg_catalog, public`; role or user-schema defaults cannot redirect catalog
lookups. It does not prove authenticity or restored database semantics.

Ownership checks apply to application relations, routines, and types in `public`. The built-in
`plpgsql` extension is inherited from `template0` and may retain the cluster bootstrap role as its
owner, so its owner identity is excluded from the fingerprint while its name, version, schema, and
relocatable state remain pinned. No other extension or public-object ownership exception is made.

## Restore

Create a new target from `template0`; do not migrate it:

```sql
CREATE DATABASE recovery_candidate TEMPLATE template0;
```

Run restore with the target URL in the restore-only variable and repeat the exact database name:

```sh
RESTORE_DATABASE_URL='postgres://operator@host/recovery_candidate' \
PG_RESTORE_PATH=/path/to/pg_restore \
npm run backup -- restore \
  --artifact-dir /restricted/new-backup \
  --confirm-empty-database recovery_candidate \
  --report /restricted/new-recovery-report.json
```

The report path must not exist. Restore never falls back to a source URL and never uses `--clean`,
`--create`, `DROP`, or `TRUNCATE`. The archive phase is one transaction. If later verification
fails, the populated target is left untouched and the report says `activationAllowed: false`; the
operator must investigate or discard that owned target manually rather than retry over it.

After the restored baseline matches the backup manifest, one recovery transaction:

- revokes every credential active at snapshot time while preserving earlier revocation timestamps;
- converts leased jobs at attempts 1 through 4 to pending;
- converts leased jobs at attempt 5 to dead letter;
- clears lease owner and expiry and increments lease generation; and
- verifies protected columns and unchanged tables;
- proves that no active credential and no leased job remains; and
- binds the schema fingerprint, before/after row digests, counts, and zero-count assertions into the
  recovery outcome digest.

If a failed restore cannot inspect whether the target contains application tables, the failure
report records `targetPopulated: "unknown"` rather than treating an inspection failure as empty.

Only an `activationAllowed: true` report permits promotion. Before promotion, issue a fresh
administrator credential through `npm run admin -- issue-token`, verify authenticated reads, run the
worker against the candidate, preserve the report with the artifact, and change deployment
configuration in a separate controlled step. Every pre-backup raw token must fail after recovery.

## Rehearsal

The explicit suite requires real PostgreSQL 17 tools and disposable database-creation authority. It
never silently skips:

```sh
DATABASE_URL='postgres://operator@host/admin' \
PG_DUMP_PATH=/path/to/pg_dump \
PG_RESTORE_PATH=/path/to/pg_restore \
npm run test:backup
```

Use only generated disposable databases. The default PostgreSQL suite remains `npm run
test:postgres`; the backup suite is separate because it creates and restores whole databases.
