import type { CommandIdentity, ProjectKbClient } from "@slop-lab/akb-project-kb/client"
import type { Page } from "@slop-lab/akb-project-kb/contracts"
import { ProjectNotebook } from "@slop-lab/akb-project-kb/react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}

window.IS_REACT_ACT_ENVIRONMENT = true

const PAGE: Page = {
  id: "page-1",
  workspaceId: "workspace-1",
  spaceId: null,
  parentPageId: "notebook-1",
  title: "Opening cue",
  revision: 3,
  lifecycle: "active",
  document: {
    version: 1,
    blocks: [{ id: "heading-1", type: "heading", text: "First pass", children: [], level: 2 }],
  },
  createdAt: "2026-10-29T08:00:00.000Z",
  updatedAt: "2026-10-29T08:00:00.000Z",
}

const NOTEBOOK: Page = {
  ...PAGE,
  id: "notebook-1",
  parentPageId: null,
  title: "Album library",
  revision: 1,
  document: { version: 1, blocks: [] },
}

class CommittedResponseLostError extends Error {}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  )
}

async function renderNotebook(client: ProjectKbClient) {
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () => {
    root.render(<ProjectNotebook client={client} projectId="project-a" projectName="Album A" />)
  })
  return { container, root }
}

test("retries a committed notebook creation with the same command identity", async () => {
  // Given
  const identities: (CommandIdentity | undefined)[] = []
  let committedNotebookCount = 0
  const client: ProjectKbClient = {
    getNotebook: async () => ({ projectId: "project-a", notebook: null }),
    createNotebook: async (_projectId, _input, identity) => {
      identities.push(identity)
      if (identities.length === 1) {
        committedNotebookCount += 1
        throw new CommittedResponseLostError("Notebook response lost")
      }
      if (identity?.commandId !== identities[0]?.commandId) committedNotebookCount += 1
      return NOTEBOOK
    },
    listPages: async () => [],
    getPage: async () => PAGE,
    createPage: async () => PAGE,
    savePage: async () => PAGE,
  }
  const { container, root } = await renderNotebook(client)

  // When
  await act(async () => button(container, "Create library")?.click())
  expect(container.textContent).toContain("Notebook response lost")
  await act(async () => button(container, "Create library")?.click())

  // Then
  expect(identities[0]).toBeDefined()
  expect(identities[1]).toEqual(identities[0])
  expect(committedNotebookCount).toBe(1)
  expect(container.textContent).toContain("No documents yet")
  act(() => root.unmount())
})

test("does not reuse notebook creation identity after its title input changes", async () => {
  // Given
  const identities: (CommandIdentity | undefined)[] = []
  const client: ProjectKbClient = {
    getNotebook: async () => ({ projectId: "project-a", notebook: null }),
    createNotebook: async (_projectId, _input, identity) => {
      identities.push(identity)
      if (identities.length === 1) throw new CommittedResponseLostError("Notebook response lost")
      return NOTEBOOK
    },
    listPages: async () => [],
    getPage: async () => PAGE,
    createPage: async () => PAGE,
    savePage: async () => PAGE,
  }
  const { container, root } = await renderNotebook(client)
  await act(async () => button(container, "Create library")?.click())

  // When
  await act(async () => {
    root.render(
      <ProjectNotebook client={client} projectId="project-a" projectName="Renamed Album" />,
    )
  })
  await act(async () => button(container, "Create library")?.click())

  // Then
  expect(identities[0]).toBeDefined()
  expect(identities[1]).not.toEqual(identities[0])
  act(() => root.unmount())
})

test("retries a committed document creation with the same identity and retained form input", async () => {
  // Given
  const identities: (CommandIdentity | undefined)[] = []
  let committedPageCount = 0
  const client: ProjectKbClient = {
    getNotebook: async () => ({ projectId: "project-a", notebook: NOTEBOOK }),
    createNotebook: async () => NOTEBOOK,
    listPages: async () => (identities.length < 2 ? [] : [PAGE]),
    getPage: async () => PAGE,
    createPage: async (_input, identity) => {
      identities.push(identity)
      if (identities.length === 1) {
        committedPageCount += 1
        throw new CommittedResponseLostError("Create response lost")
      }
      if (identity?.commandId !== identities[0]?.commandId) committedPageCount += 1
      return PAGE
    },
    savePage: async () => PAGE,
  }
  const { container, root } = await renderNotebook(client)
  const title = container.querySelector<HTMLInputElement>('input[name="title"]')
  const createForm = container.querySelector<HTMLFormElement>("form.kb-create-form")
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      title,
      "Opening cue",
    )
    title?.dispatchEvent(new Event("input", { bubbles: true }))
  })

  // When
  await act(async () =>
    createForm?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })),
  )
  expect(title?.value).toBe("Opening cue")
  await act(async () =>
    createForm?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })),
  )

  // Then
  expect(identities[0]).toBeDefined()
  expect(identities[1]).toEqual(identities[0])
  expect(committedPageCount).toBe(1)
  expect(container.textContent).toContain("Revision 3")

  // When
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      title,
      "Changed cue",
    )
    title?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () =>
    createForm?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })),
  )

  // Then
  expect(identities[2]).not.toEqual(identities[0])
  expect(committedPageCount).toBe(2)
  act(() => root.unmount())
})

test("retries a committed save with the same identity until the draft changes", async () => {
  // Given
  const identities: (CommandIdentity | undefined)[] = []
  let committedSaveCount = 0
  const saved = { ...PAGE, revision: 4, title: "Second pass" }
  const client: ProjectKbClient = {
    getNotebook: async () => ({ projectId: "project-a", notebook: NOTEBOOK }),
    createNotebook: async () => NOTEBOOK,
    listPages: async () => [identities.length < 2 ? PAGE : saved],
    getPage: async () => PAGE,
    createPage: async () => PAGE,
    savePage: async (_input, identity) => {
      identities.push(identity)
      if (identities.length === 1) {
        committedSaveCount += 1
        throw new CommittedResponseLostError("Save response lost")
      }
      if (identity?.commandId !== identities[0]?.commandId) committedSaveCount += 1
      return saved
    },
  }
  const { container, root } = await renderNotebook(client)
  const title = container.querySelector<HTMLInputElement>('input[value="Opening cue"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      title,
      "Second pass",
    )
    title?.dispatchEvent(new Event("input", { bubbles: true }))
  })

  // When
  await act(async () => button(container, "Save document")?.click())
  expect(title?.value).toBe("Second pass")
  await act(async () => button(container, "Save document")?.click())

  // Then
  expect(identities[0]).toBeDefined()
  expect(identities[1]).toEqual(identities[0])
  expect(committedSaveCount).toBe(1)
  expect(container.querySelector<HTMLInputElement>('input[value="Second pass"]')).not.toBeNull()

  // When
  const savedTitle = container.querySelector<HTMLInputElement>('input[value="Second pass"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      savedTitle,
      "Third pass",
    )
    savedTitle?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => button(container, "Save document")?.click())

  // Then
  expect(identities[2]).not.toEqual(identities[0])
  expect(committedSaveCount).toBe(2)
  act(() => root.unmount())
})
