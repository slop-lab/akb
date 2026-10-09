# ADR-016: Snapshot Backup and Quarantined Restore

- Status: proposed
- Date: 2026-10-09
- Owners: repository maintainers
- Reviewers: persistence, operations, and security reviewers

## Context

Migration checksums and durable tests do not prove that operators can recover schema 004 data.
Logical backup also risks inconsistent evidence if archive and digest observations use different
snapshots. Restoring credential hashes or in-flight leases without a fence can resurrect authority
or let a stale worker finalize work after recovery.

## Considered options

- Independent `pg_dump` and digest reads were rejected because concurrent commits could make the
  archive and evidence describe different database states.
- Physical backups or immediate PITR infrastructure were rejected for this bounded checkpoint
  because they require deployment, retention, and storage decisions beyond schema-004 rehearsal;
  they remain required future operational work.
- In-place restore with `--clean` was rejected because a mistaken target could destroy existing
  data and a failed attempt would erase diagnostic state.
- Restoring credentials and leases unchanged was rejected because it could resurrect bearer
  authority and permit stale workers to acknowledge recovered jobs.

## Proposed decision

Provide one strict operator CLI with `create`, `verify`, and `restore`. Creation combines a
PostgreSQL 17 custom-format public-schema archive with ordered streaming table digests from the same
exported read-only repeatable-read snapshot. The restricted artifact has a fixed two-file format and
records exact migration, pinned schema-catalog, table, archive, and semantic digests. Table hashing
uses fixed session formatting and UTF-8 byte ordering for text keys while preserving numeric key
ordering. Catalog validation is transaction-bound, fixes `search_path` to `pg_catalog, public`, and
fingerprints all public relation and type classes plus the other schema-scoped object classes the
bounded dump can contain. Unknown types, composite relations, or RLS state therefore fail closed.

Restore accepts only a separately configured, pre-created, owned, UTF-8 PostgreSQL 17 database that
matches an explicit name confirmation and the pristine `template0` catalog. It does not clean,
create, or overwrite a database. The archive restore is transactional. Before activation, complete
restored digests must match the snapshot manifest.

Credential and lease quarantine is mandatory. Every restored active credential is revoked at one
recovery timestamp. Every leased outbox job clears ownership and expiry, increments generation, and
returns to pending unless attempt five requires dead letter. Protected-column and unchanged-table
digests are verified in the recovery transaction. A private new-only report is the activation gate.
The transaction independently proves that no active credential or leased job remains, and the
report binds those assertions and its before/after digests into one outcome digest.

## Scope and non-goals

This proposal covers only the current public schema through migration 004. It does not provide PITR,
continuous archiving, scheduling, object-storage lifecycle, encrypted backup storage, signatures,
remote transfer, automatic deployment activation, or cleanup of failed targets. It does not claim
R3 completion.

## Security, data, operational, migration, and compatibility consequences

Artifacts contain plaintext application data and credential verifier material. Mode `0600` is not
encryption, and SHA-256 integrity is not authenticity. PostgreSQL archives can execute source SQL,
so only trusted operator artifacts may be restored. Tools receive a password-free PostgreSQL URI;
the password is passed through a scrubbed child environment that excludes inherited `PG*` settings.
Operators should additionally isolate the tool host because process environments can be observable
to privileged local users.

A failed post-restore check deliberately leaves a populated, non-activatable target for diagnosis.
The CLI never destroys it. A long exported snapshot can increase vacuum retention pressure.

Verification binds artifacts to the repository's exact migration catalog and a stable catalog
projection fingerprint derived twice from fresh local schema-004 migrations. Artifacts from a
different migration or schema catalog fail closed rather than receiving a compatibility shim, and
this decision introduces no migration or schema change. The archive contains the complete bounded
application dataset, so its storage and disposal inherit the sensitivity of the source database.

## Verification conditions

Unit tests cover strict parsing, paths, modes, symlinks, manifests, tampering, redaction, and tool
contracts. A real PostgreSQL 17 database-to-database rehearsal must prove same-snapshot data,
empty-target guards, baseline equality, mandatory credential revocation, exact lease repair,
old-token and stale-ack failure, fresh administrator authentication, and inbox deduplication.

## Related decisions

ADR-013, ADR-014, and ADR-015 remain proposed. This proposal adds operational evidence for their
bounded schema but does not change their status or complete R3.
