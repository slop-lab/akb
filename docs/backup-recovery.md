# PostgreSQL Backup and Recovery Runbook

## Scope

The operator CLI provides seven explicit immutable PostgreSQL 17 backup profiles. Existing format-1
`r3-schema-004-public` and format-2 schema-008/schema-009/schema-010/schema-016 artifacts retain
their shipped migration, table, fingerprint, and digest contracts. Profiles 017 and 018 are
separate immutable contracts. Databases at migration 018 create format-2 artifacts with profile
`project-kb-schema-018-public-v1`. The CLI creates one
custom-format archive and a same-snapshot
semantic manifest, verifies local artifact integrity offline, and restores only to a pre-created
pristine database. It is not PITR, scheduling, replication, encrypted storage, authenticity signing,
or a complete release backup program.

The artifact contains all application data, including credential hashes. File permissions are not
encryption. Treat both artifact files and recovery reports as restricted operational material. A
digest detects accidental changes but does not authenticate an artifact. `pg_restore` executes SQL
from the archive, so restore only artifacts from a trusted operator and source database.

## Requirements

- Node.js 26.12.1, pnpm 10.17.1, and dependencies from the committed lockfile.
- PostgreSQL 17 source and target servers.
- PostgreSQL 17 `pg_dump` and `pg_restore` clients, selected with `PG_DUMP_PATH` and
  `PG_RESTORE_PATH` when they are not on `PATH`.
- A source database with exactly a registered 001-004, 001-008, 001-009, 001-010, 001-016,
  001-017, or 001-018 ledger and its documented public catalog. Any intermediate, future, or
  unknown ledger fails closed.
- A target database owned by the restore user, encoded UTF-8, created from `template0`, with no
  other sessions or user objects.

Never point restore at an application or worker database. The new target must remain disconnected
from API and worker configuration until the success report says `activationAllowed: true`.

## Registered profiles

| Profile | Format | Source ledger | Catalog and ownership contract |
| --- | ---: | --- | --- |
| `r3-schema-004-public` | 1 | migrations `001`-`004` | Original public schema profile and pinned ownership semantics |
| `r4-schema-008-public-v1` | 2 | migrations `001`-`008` | 48-table public schema profile; trusted PostgreSQL 17 `pgcrypto` in `public`; application relations, routines, and types owned under the database-owner policy |
| `r4-schema-009-public-v1` | 2 | migrations `001`-`009` | Same 48-table resource set and schema fingerprint as 008; migration 009 adds deterministic legacy workflow revision history without catalog drift |
| `r4-schema-010-public-v1` | 2 | migrations `001`-`010` | 48-table catalog with the nullable frozen legacy PM projection sidecar and its constraint |
| `r8-schema-016-public-v1` | 2 | migrations `001`-`016` | R5-R8 planning, content, runtime, knowledge, integration, and automation resources |
| `project-kb-schema-017-public-v1` | 2 | migrations `001`-`017` | Profile 016 plus the immutable Project-to-root-Page `project_notebooks` mapping |
| `project-kb-schema-018-public-v1` | 2 | migrations `001`-`018` | Profile 017 table catalog plus trigger-enforced retention of notebook associations |

The immutable migration-009 checksum is
`fb962024d4c2045cbb72dfaccf6bed4a3ff95383800a8303b4c8427b8060fbd4`; migration 010 is
`88c1308455b0b790aed2a07d8294f72701c73857faccda3a3ea62f4bc6b21a04`. Profiles 008 and 009 share
schema fingerprint `9ee67a3a89d8cf7f47c93ab0136b0c93f00bc605e40f539d7afa5d4bd0ee6242`.
Profile 010 is pinned to
`1002d3c51bc4984a8cd4fbc9aadb56e3a7241adcb4f6149a5bd2615cb05eddac`.
Migration 017 is pinned to
`6b0082c343886b3853997e1020750d5ccc35904d1235df95612c651559394fa0`; profile 017 is pinned to
schema fingerprint `6ca931bc2f9089970d232665d6ccc39a294e7bf53909cd48bd02821b8f085fdd`.
Migration 018 is pinned to
`1b45ce5956ba727b2b1ea78638fcb043591f0ea4f422c5bfede6e110c35720ad`; profile 018 is pinned to
schema fingerprint `d6b795527ac83dba80e21712ee1760da06e2bba162f4d4486e50a7171c878188`.

The profile source is `src/operations/backup/profiles.ts`; ordered resources are in
`src/operations/backup/resources.ts`. No user metadata, Space membership, token, or secret is added
to the profile as an out-of-band side channel: application rows remain ordinary protected backup
content, while profile metadata contains only the registered operational contract.

Backup database URLs accept no connection query option except one validated `sslmode`. PostgreSQL
tools receive a reconstructed password-free URI plus `PGPASSWORD`; inherited `PG*` variables are
removed before launch so service files, host addresses, or options cannot redirect the operation.

## Create

Use exactly one source URL. The artifact path must not exist.

```sh
SOURCE_DATABASE_URL='postgres://operator@host/source' \
PG_DUMP_PATH=/path/to/pg_dump \
pnpm run backup create --artifact-dir /restricted/new-backup
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
pnpm run backup verify --artifact-dir /restricted/new-backup
```

This checks exact paths and modes, the strict format/profile union, all seven immutable local
migration-catalog prefixes, the selected profile's pinned catalog fingerprint, archive bytes and
digest, the bound overall digest, the PostgreSQL 17 version contract, and `pg_restore --list`. The
fingerprint covers public relations,
columns, all type classes, constraints, indexes, rules, triggers, routines and their configuration,
RLS state and policies, sequences, operators and related classes, casts, collations, conversions,
extended statistics, text-search objects, transforms, security labels, extensions, and ownership
semantics without storing OIDs or role names. Projection and validation run in one transaction with
`search_path` fixed to `pg_catalog, public`; role or user-schema defaults cannot redirect catalog
lookups. It does not prove authenticity or restored database semantics.

Ownership checks apply to application relations, routines, and types in `public`. Objects managed
by a trusted extension can retain the cluster bootstrap owner when an ordinary database owner
installs that extension, so component ownership is normalized while extension identity, version,
schema, relocatability, and ownership-by-database-owner remain pinned. Profiles 008 and later
require the trusted PostgreSQL 17 `pgcrypto` extension in `public` and fingerprint its public
routines.

## Restore

Create a new target from `template0`; do not migrate it:

```sql
CREATE DATABASE recovery_candidate TEMPLATE template0;
```

Run restore with the target URL in the restore-only variable and repeat the exact database name:

```sh
RESTORE_DATABASE_URL='postgres://operator@host/recovery_candidate' \
PG_RESTORE_PATH=/path/to/pg_restore \
pnpm run backup restore \
  --artifact-dir /restricted/new-backup \
  --confirm-empty-database recovery_candidate \
  --report /restricted/new-recovery-report.json
```

The report path must not exist. Restore never falls back to a source URL and never uses `--clean`,
`--create`, `DROP`, or `TRUNCATE`. The archive phase is one transaction. If later verification
fails, the populated target is left untouched and the report says `activationAllowed: false`; the
operator must investigate or discard that owned target manually rather than retry over it.

After the restored source baseline matches the backup manifest, one recovery transaction:

- revokes every credential active at snapshot time while preserving earlier revocation timestamps;
- converts leased jobs at attempts 1 through 4 to pending;
- converts leased jobs at attempt 5 to dead letter;
- clears lease owner and expiry and increments lease generation; and
- verifies protected columns and unchanged tables;
- fences the same mutable columns in `entity_outbox_jobs_v1`;
- clears Human Query snapshots and only `validated` import batches/mappings while preserving
  committed import identity mappings, generic command idempotency, canonical history, and ACL data;
- proves that no active credential and no legacy or generic leased job remains; and
- binds the schema fingerprint, before/after row digests, counts, and zero-count assertions into the
  recovery outcome digest.

A restore first validates the exact source profile and quarantines that baseline. Profiles 016 and
017 quarantine their full R8 authority before upgrade so recovery reports retain all observable
counts. Older sources apply only their remaining registered migrations through 018; profile-016
applies migrations 017 and 018, while profile-017 applies only migration 018. The restore validates
the final profile-018 fingerprint and complete
table catalog, performs the authority/transient-state quarantine, and emits a format-2 recovery
report containing source and final profiles and baselines. A schema-018 restore validates directly
before quarantine. Restore installs `pgcrypto` before
loading a format-2 archive because PostgreSQL schema-filtered dumps do not include extension-managed
objects.

If a failed restore cannot inspect whether the target contains application tables, the failure
report records `targetPopulated: "unknown"` rather than treating an inspection failure as empty.

Only an `activationAllowed: true` report permits promotion. Before promotion, issue a fresh
administrator credential through `pnpm run admin issue-token`, verify authenticated reads, run the
worker against the candidate, preserve the report with the artifact, and change deployment
configuration in a separate controlled step. Every pre-backup raw token must fail after recovery.

## Rehearsal

The explicit suite requires real PostgreSQL 17 tools and disposable database-creation authority. It
never silently skips:

```sh
DATABASE_URL='postgres://operator@host/admin' \
PG_DUMP_PATH=/path/to/pg_dump \
PG_RESTORE_PATH=/path/to/pg_restore \
pnpm run test:backup
```

The suite covers fresh-owner fingerprint equivalence, ordinary-owner format-2 restore, each older
registered profile upgraded through 018, including the exact 016-to-018 and 017-to-018 suffixes,
and a real format-1
artifact. A separate legacy SDK driver
observed a schema-004 -> schema-010 database upgrade, detail/list/continuation behavior, and unchanged history.
Recovery operators still need an explicit post-restore `grant-r4-permissions` action for existing
members; recovery never widens old membership grants implicitly. Independent `npm run test:backup`
acceptance passed all 28 tests at source commit `260812d`, including real registered
004/008/009/010 recovery paths. This is local recovery evidence, not a production or CI claim.

Use only generated disposable databases. The default PostgreSQL suite remains `pnpm run
test:postgres`; the backup suite is separate because it creates and restores whole databases.
