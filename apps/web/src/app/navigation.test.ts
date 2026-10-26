import { expect, test } from "vitest"
import { hrefForLocation, parseLocation } from "./navigation.ts"

test("parses exact Page and Knowledge revisions from durable deep links", () => {
  // Given
  const pageUrl = new URL("https://akb.example/workspaces/workspace-1/pages/page-42?revision=7")
  const knowledgeUrl = new URL(
    "https://akb.example/workspaces/workspace-1/knowledge/claim-9?revision=3",
  )

  // When
  const page = parseLocation(pageUrl)
  const knowledge = parseLocation(knowledgeUrl)

  // Then
  expect(page).toEqual({
    route: "content",
    workspaceId: "workspace-1",
    pageId: "page-42",
    revision: 7,
  })
  expect(knowledge).toEqual({
    route: "knowledge",
    workspaceId: "workspace-1",
    knowledgeId: "claim-9",
    revision: 3,
  })
})

test("roundtrips proposal inbox and detail locations without credentials", () => {
  // Given
  const inbox = { route: "proposals", workspaceId: "workspace-1" } as const
  const detail = {
    route: "proposals",
    workspaceId: "workspace-1",
    proposalId: "proposal-17",
  } as const

  // When / Then
  expect(parseLocation(new URL(hrefForLocation(inbox), "https://akb.example"))).toEqual(inbox)
  expect(parseLocation(new URL(hrefForLocation(detail), "https://akb.example"))).toEqual(detail)
  expect(hrefForLocation(detail)).toBe("/workspaces/workspace-1/proposals/proposal-17")
})

test("reports invalid historical revisions instead of substituting latest", () => {
  // Given / When
  const location = parseLocation(new URL("https://akb.example/pages/page-42?revision=latest"))

  // Then
  expect(location).toEqual({
    route: "content",
    pageId: "page-42",
    revisionError: "Revision must be a positive integer.",
  })
})
