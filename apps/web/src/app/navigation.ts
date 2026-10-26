import type { Route } from "./types.ts"

type LocationBase = { readonly workspaceId?: string }
type RevisionLocation = {
  readonly revision?: number
  readonly revisionError?: string
}

export type AppLocation = LocationBase &
  (
    | ({ readonly route: "content"; readonly pageId?: string } & RevisionLocation)
    | ({ readonly route: "knowledge"; readonly knowledgeId?: string } & RevisionLocation)
    | { readonly route: "proposals"; readonly proposalId?: string }
    | { readonly route: Exclude<Route, "content" | "knowledge" | "proposals"> }
  )

const staticRouteFrom = (
  path: string,
): Exclude<Route, "content" | "knowledge" | "proposals"> | undefined => {
  switch (path) {
    case "projects":
    case "spaces":
    case "work":
    case "search":
    case "planning":
    case "runtime":
    case "automation":
    case "transfer":
      return path
    case "saved-views":
      return "saved"
    default:
      return undefined
  }
}

const decodeSegment = (segment: string | undefined): string | undefined => {
  if (segment === undefined || segment.length === 0) return undefined
  try {
    const decoded = decodeURIComponent(segment)
    return decoded.length === 0 || decoded.includes("/") || decoded.includes("\\")
      ? undefined
      : decoded
  } catch (caught) {
    if (caught instanceof URIError) return undefined
    throw caught
  }
}

const revisionFrom = (url: URL): RevisionLocation => {
  const raw = url.searchParams.get("revision")
  if (raw === null) return {}
  if (!/^[1-9]\d*$/.test(raw)) return { revisionError: "Revision must be a positive integer." }
  const revision = Number(raw)
  return Number.isSafeInteger(revision)
    ? { revision }
    : { revisionError: "Revision must be a positive integer." }
}

export function parseLocation(url: URL): AppLocation {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0)
  const qualified = segments[0] === "workspaces"
  const workspaceId = qualified ? decodeSegment(segments[1]) : undefined
  const section = qualified ? (segments[2] ?? "") : (segments[0] ?? "")
  const entityId = decodeSegment(qualified ? segments[3] : segments[1])
  const workspace = workspaceId === undefined ? {} : { workspaceId }
  switch (section) {
    case "pages":
      return {
        route: "content",
        ...workspace,
        ...(entityId === undefined ? {} : { pageId: entityId }),
        ...revisionFrom(url),
      }
    case "knowledge":
      return {
        route: "knowledge",
        ...workspace,
        ...(entityId === undefined ? {} : { knowledgeId: entityId }),
        ...revisionFrom(url),
      }
    case "proposals":
      return {
        route: "proposals",
        ...workspace,
        ...(entityId === undefined ? {} : { proposalId: entityId }),
      }
    case "":
      return { route: "projects", ...workspace }
    default: {
      const route = staticRouteFrom(section)
      return route === undefined ? { route: "projects", ...workspace } : { route, ...workspace }
    }
  }
}

const prefixFor = (location: AppLocation): string =>
  location.workspaceId === undefined
    ? ""
    : `/workspaces/${encodeURIComponent(location.workspaceId)}`

export function hrefForLocation(location: AppLocation): string {
  const prefix = prefixFor(location)
  switch (location.route) {
    case "content": {
      const path =
        location.pageId === undefined
          ? `${prefix}/pages`
          : `${prefix}/pages/${encodeURIComponent(location.pageId)}`
      return location.revision === undefined ? path : `${path}?revision=${location.revision}`
    }
    case "knowledge": {
      const path =
        location.knowledgeId === undefined
          ? `${prefix}/knowledge`
          : `${prefix}/knowledge/${encodeURIComponent(location.knowledgeId)}`
      return location.revision === undefined ? path : `${path}?revision=${location.revision}`
    }
    case "proposals":
      return location.proposalId === undefined
        ? `${prefix}/proposals`
        : `${prefix}/proposals/${encodeURIComponent(location.proposalId)}`
    case "projects":
      return `${prefix}/projects`
    case "saved":
      return `${prefix}/saved-views`
    case "spaces":
    case "work":
    case "search":
    case "planning":
    case "runtime":
    case "automation":
    case "transfer":
      return `${prefix}/${location.route}`
    default:
      return assertNever(location)
  }
}

export function withWorkspace(location: AppLocation, workspaceId: string): AppLocation {
  return { ...location, workspaceId }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported application location: ${JSON.stringify(value)}`)
}
