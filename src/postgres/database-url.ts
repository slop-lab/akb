import { z } from "zod"

const SslModeSchema = z.enum(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"])

export type ParsedDatabaseUrl = {
  readonly clientUrl: string
  readonly toolUrl: string
  readonly databaseName: string
  readonly password: string
  readonly sslmode?: z.infer<typeof SslModeSchema>
}

export function parsePostgresDatabaseUrl(rawUrl: string): ParsedDatabaseUrl {
  const url = new URL(rawUrl)
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TypeError("database URL must use PostgreSQL")
  }
  if (url.hash.length > 0) throw new TypeError("database URL must not contain a fragment")
  const optionNames = [...new Set(url.searchParams.keys())]
  if (optionNames.some((name) => name !== "sslmode")) {
    throw new TypeError("database URL contains an unsupported option")
  }
  const sslmodeValues = url.searchParams.getAll("sslmode")
  if (sslmodeValues.length > 1) throw new TypeError("database URL contains a duplicate option")
  const sslmode = sslmodeValues[0]
  const parsedSslmode = sslmode === undefined ? undefined : SslModeSchema.parse(sslmode)
  const databaseName = decodeURIComponent(url.pathname.slice(1))
  const hasControlCharacter = Array.from(databaseName).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127
  })
  if (databaseName.length === 0 || databaseName.includes("/") || hasControlCharacter) {
    throw new TypeError("database URL must name one database")
  }
  const password = decodeURIComponent(url.password)
  const toolUrl = new URL(url)
  toolUrl.password = ""
  return {
    clientUrl: url.toString(),
    toolUrl: toolUrl.toString(),
    databaseName,
    password,
    ...(parsedSslmode === undefined ? {} : { sslmode: parsedSslmode }),
  }
}
