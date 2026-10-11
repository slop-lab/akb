import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import {
  type ImportRecord,
  ImportRecordSchema,
  type ImportValidation,
} from "../contracts/r4/index.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"

const MAX_BYTES = 10 * 1024 * 1024
const MAX_RECORDS = 10_000
const TokenSchema = z.strictObject({
  importId: z.string().uuid(),
  workspaceId: z.string(),
  principalId: z.string(),
  credentialId: z.string(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  authorityEpoch: z.number().int().positive(),
  expiresAt: z.string(),
  commandId: z.string(),
  idempotencyKey: z.string(),
})

export type ImportBinding = { readonly commandId: string; readonly idempotencyKey: string }
export type ValidatedBatch = {
  readonly importId: string
  readonly digest: string
  readonly byteSize?: number
  readonly records: readonly ImportRecord[]
}
export interface ImportCommandDispatcher {
  validateCommands(
    transaction: TransactionSql,
    principal: AuthenticatedPrincipal,
    batch: ValidatedBatch,
  ): Promise<readonly string[]>
  importCommands(
    transaction: TransactionSql,
    principal: AuthenticatedPrincipal,
    batch: ValidatedBatch,
  ): Promise<{ readonly replayed: boolean }>
}

export class ImportValidationError extends Error {
  override readonly name = "ImportValidationError"
}

export class ImportConflictError extends Error {
  override readonly name = "ImportConflictError"
}

export class ImportService {
  private readonly sql: Sql
  private readonly signingKey: Uint8Array
  private readonly dispatcher: ImportCommandDispatcher

  constructor(sql: Sql, signingKey: Uint8Array, dispatcher: ImportCommandDispatcher) {
    if (signingKey.byteLength < 32) throw new RangeError("import signing key requires 32 bytes")
    this.sql = sql
    this.signingKey = signingKey
    this.dispatcher = dispatcher
  }

  async validate(
    principal: AuthenticatedPrincipal,
    body: Uint8Array,
    binding: ImportBinding,
  ): Promise<ImportValidation> {
    const batch = parseBatch(body, principal.workspaceId)
    return this.sql.begin(async (transaction) => {
      const authority = await readAuthority(transaction, principal)
      const warnings = await this.dispatcher.validateCommands(transaction, principal, batch)
      const payload = {
        importId: batch.importId,
        workspaceId: principal.workspaceId,
        principalId: principal.principalId,
        credentialId: principal.credentialId,
        digest: batch.digest,
        authorityEpoch: authority.epoch,
        expiresAt: authority.expiresAt,
        ...binding,
      }
      return {
        importId: batch.importId,
        contentDigest: batch.digest,
        recordCount: batch.records.length,
        validationToken: sign(payload, this.signingKey),
        expiresAt: authority.expiresAt,
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    })
  }

  async commit(
    principal: AuthenticatedPrincipal,
    body: Uint8Array,
    token: string,
    binding: ImportBinding,
  ): Promise<{
    readonly importId: string
    readonly committed: true
    readonly replayed: boolean
    readonly recordCount: number
  }> {
    const batch = parseBatch(body, principal.workspaceId)
    return this.sql.begin(async (transaction) => {
      const authority = await readAuthority(transaction, principal)
      const payload = verify(token, this.signingKey)
      const basicMatch =
        payload.importId === batch.importId &&
        payload.workspaceId === principal.workspaceId &&
        payload.principalId === principal.principalId &&
        payload.credentialId === principal.credentialId &&
        payload.commandId === binding.commandId &&
        payload.idempotencyKey === binding.idempotencyKey &&
        payload.expiresAt > authority.now
      if (!basicMatch) throw new ImportValidationError("validation token does not match the import")
      const committed = await transaction<
        { readonly content_digest: string; readonly principal_id: string }[]
      >`
        select content_digest,principal_id from import_batches where workspace_id=${principal.workspaceId}
          and import_id=${batch.importId} and state='committed' for update`
      if (committed[0] !== undefined) {
        if (
          committed[0].content_digest !== batch.digest ||
          committed[0].principal_id !== principal.principalId
        ) {
          throw new ImportConflictError("import identity conflicts with content")
        }
        if (payload.digest !== batch.digest)
          throw new ImportValidationError("validation token does not match the import")
      } else {
        if (payload.digest !== batch.digest)
          throw new ImportValidationError("validation token does not match the import")
        if (payload.authorityEpoch !== authority.epoch)
          throw new ImportValidationError("import authority changed")
        await this.dispatcher.validateCommands(transaction, principal, batch)
      }
      const result = await this.dispatcher.importCommands(transaction, principal, batch)
      return {
        importId: batch.importId,
        committed: true,
        replayed: result.replayed,
        recordCount: batch.records.length,
      }
    })
  }
}

function parseBatch(body: Uint8Array, workspaceId: string): ValidatedBatch {
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES)
    throw new ImportValidationError("import byte limit exceeded")
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body)
  } catch (error) {
    if (error instanceof TypeError) throw new ImportValidationError("import is not valid UTF-8")
    throw error
  }
  const rawLines = text.split("\n")
  if (rawLines.at(-1) === "") rawLines.pop()
  if (
    rawLines.length === 0 ||
    rawLines.length > MAX_RECORDS ||
    rawLines.some((line) => line.length === 0)
  ) {
    throw new ImportValidationError("import record limit exceeded")
  }
  let records: readonly ImportRecord[]
  try {
    records = rawLines.map((line) => ImportRecordSchema.parse(JSON.parse(line)))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      throw new ImportValidationError("invalid import record")
    throw error
  }
  const manifest = records[0]
  if (manifest?.kind !== "manifest" || manifest.workspaceId !== workspaceId)
    throw new ImportValidationError("invalid manifest")
  if (records.slice(1).some((record) => record.kind === "manifest"))
    throw new ImportValidationError("manifest must be first")
  const externalIds = records.flatMap((record) =>
    "externalId" in record ? [record.externalId] : [],
  )
  if (new Set(externalIds).size !== externalIds.length)
    throw new ImportValidationError("duplicate external id")
  return {
    importId: manifest.importId,
    digest: createHash("sha256").update(body).digest("hex"),
    byteSize: body.byteLength,
    records,
  }
}

async function readAuthority(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
): Promise<{
  readonly epoch: number
  readonly now: string
  readonly expiresAt: string
}> {
  if (!(await lockAuthenticatedPrincipal(transaction, principal)))
    throw new ImportValidationError("import authority denied")
  const rows = await transaction<
    { readonly epoch: number; readonly now: string; readonly expires_at: string }[]
  >`select a.epoch::integer epoch,
      to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') now,
      to_char(clock_timestamp()+interval '15 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expires_at
    from workspace_authority_epochs a join principal_credentials c on c.workspace_id=a.workspace_id
      and c.principal_id=${principal.principalId} and c.id=${principal.credentialId}
    join membership_permissions p on p.workspace_id=a.workspace_id and p.principal_id=${principal.principalId}
      and p.permission='project.manage'
    where a.workspace_id=${principal.workspaceId} and c.revoked_at is null and c.expires_at>clock_timestamp()`
  const row = rows[0]
  if (row === undefined) throw new ImportValidationError("import authority denied")
  return { epoch: row.epoch, now: row.now, expiresAt: row.expires_at }
}

function sign(payload: z.infer<typeof TokenSchema>, key: Uint8Array): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`
}

function verify(token: string, key: Uint8Array): z.infer<typeof TokenSchema> {
  const [encoded, signature, extra] = token.split(".")
  if (encoded === undefined || signature === undefined || extra !== undefined)
    throw new ImportValidationError("invalid validation token")
  const expected = createHmac("sha256", key).update(encoded).digest()
  const supplied = Buffer.from(signature, "base64url")
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    throw new ImportValidationError("invalid validation token")
  try {
    return TokenSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      throw new ImportValidationError("invalid validation token")
    throw error
  }
}
