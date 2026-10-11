# ADR-020: Versioned Current Backup Profiles

- Status: proposed
- Date: 2026-10-11
- Owners: repository maintainers
- Reviewers: persistence, operations, and security reviewers

## Context

ADR-016 defines the bounded schema-004 snapshot and quarantine contract. The additive schema-008
foundation changes migration, table, extension, fingerprint, transient-state, and generic-lease
requirements. Silently treating both catalogs as one format would weaken restore validation and old
artifact compatibility.

## Considered options

- Reject every schema-004 artifact after migration 008. Rejected because existing immutable backup
  artifacts retain operational value.
- Auto-detect arbitrary schemas and best-effort restore. Rejected because unknown ledgers and
  catalogs must fail closed.
- Register immutable source/current profiles and one explicit forward upgrade. Proposed because it
  preserves old evidence and pins the current catalog.

## Proposed decision

Retain format-1 profile `r3-schema-004-public` and register format-2 profile
`r4-schema-008-public-v1`. Each profile pins the exact migration ledger, ordered public resources,
PostgreSQL 17 contract, schema fingerprint, and ownership policy. Profile 008 includes trusted
`pgcrypto` in `public` and fingerprints its public routines.

A schema-004 restore validates and quarantines the exact source baseline, applies only registered
local migrations `005`-`008`, validates the profile-008 catalog, then applies R4 quarantine. A
schema-008 restore validates directly. Both revoke active credentials, fence legacy and generic
leases, and produce a private activation report. R4 quarantine also clears Human Query snapshots and
validated import bookkeeping while retaining committed import identity mappings and canonical data.

## Scope and non-goals

Profiles contain operational catalog metadata, never bearer tokens, signing secrets, or an
out-of-band user metadata tree. Backup rows remain sensitive application data. This proposal does
not provide PITR, encrypted storage, signatures, scheduling, replication, remote transfer, or full
R8 release operations.

## Consequences and verification

Unknown/intermediate/future ledgers fail closed. Real PostgreSQL 17 rehearsals must cover ordinary
database ownership, profile fingerprint equivalence, format-2 restore, real format-1 upgrade,
credential revocation, generic and legacy lease fencing, transient clearing, and activation denial
on any mismatch.

## Related decisions

ADR-016 remains the proposed schema-004 source contract. This proposal extends compatibility to the
current profile without changing ADR-016's status or claiming R3/R4 completion.
