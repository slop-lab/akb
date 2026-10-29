import type { ProjectKbClient, SaveDocument } from "@slop-lab/akb-project-kb/client"
import { ProjectKbHttpError } from "@slop-lab/akb-project-kb/client"
import type { NotebookResponse, Page } from "@slop-lab/akb-project-kb/contracts"
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
    blocks: [
      {
        id: "heading-1",
        type: "heading",
        text: "First pass",
        children: [],
        level: 2,
        language: "music-cue",
      },
    ],
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

class SaveUnavailableError extends Error {}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

test("retains a conflicting draft until Reload latest explicitly replaces it", async () => {
  // Given
  let latest = PAGE
  const client: ProjectKbClient = {
    getNotebook: async () => ({ projectId: "project-a", notebook: NOTEBOOK }),
    createNotebook: async () => NOTEBOOK,
    listPages: async () => [latest],
    getPage: async () => latest,
    createPage: async () => PAGE,
    savePage: async () => {
      throw new ProjectKbHttpError(409, "revision_conflict")
    },
  }
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () => {
    root.render(<ProjectNotebook client={client} projectId="project-a" projectName="Album A" />)
  })
  const editor = container.querySelector("textarea")

  // When
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      editor,
      "Unsaved local pass",
    )
    editor?.dispatchEvent(new Event("input", { bubbles: true }))
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Save document")
      ?.click()
  })

  // Then
  expect(container.textContent).toContain("Your unsaved draft is retained")
  expect(container.querySelector("textarea")?.value).toBe("Unsaved local pass")

  // When
  latest = {
    ...PAGE,
    revision: 4,
    document: {
      version: 1,
      blocks: [
        {
          id: "heading-1",
          type: "heading",
          text: "Server version",
          children: [],
          level: 2,
          language: "music-cue",
        },
      ],
    },
  }
  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Reload latest")
      ?.click()
  })

  // Then
  expect(container.querySelector("textarea")?.value).toBe("Server version")
  act(() => root.unmount())
})

test("disables editable fields while a save is in flight", async () => {
  // Given
  const pendingSave = deferred<Page>()
  const client: ProjectKbClient = {
    getNotebook: async () => ({ projectId: "project-a", notebook: NOTEBOOK }),
    createNotebook: async () => NOTEBOOK,
    listPages: async () => [PAGE],
    getPage: async () => PAGE,
    createPage: async () => PAGE,
    savePage: async () => pendingSave.promise,
  }
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () => {
    root.render(<ProjectNotebook client={client} projectId="project-a" projectName="Album A" />)
  })

  // When
  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Save document")
      ?.click()
  })

  // Then
  expect(container.querySelector<HTMLInputElement>('input[value="Opening cue"]')?.disabled).toBe(
    true,
  )
  expect(container.querySelector("textarea")?.disabled).toBe(true)

  // When
  await act(async () => {
    pendingSave.resolve({ ...PAGE, revision: 4 })
  })

  // Then
  expect(container.querySelector<HTMLInputElement>('input[value="Opening cue"]')?.disabled).toBe(
    false,
  )
  expect(container.querySelector("textarea")?.disabled).toBe(false)
  act(() => root.unmount())
})

test("offers Reload latest after an untyped save failure without clearing the draft", async () => {
  // Given
  const client: ProjectKbClient = {
    getNotebook: async () => ({ projectId: "project-a", notebook: NOTEBOOK }),
    createNotebook: async () => NOTEBOOK,
    listPages: async () => [PAGE],
    getPage: async () => PAGE,
    createPage: async () => PAGE,
    savePage: async () => {
      throw new SaveUnavailableError("Save temporarily unavailable")
    },
  }
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () => {
    root.render(<ProjectNotebook client={client} projectId="project-a" projectName="Album A" />)
  })
  const editor = container.querySelector("textarea")

  // When
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      editor,
      "Local retry draft",
    )
    editor?.dispatchEvent(new Event("input", { bubbles: true }))
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Save document")
      ?.click()
  })

  // Then
  expect(container.textContent).toContain("Save temporarily unavailable")
  expect(container.textContent).toContain("Reload latest")
  expect(container.querySelector("textarea")?.value).toBe("Local retry draft")
  act(() => root.unmount())
})

test("ignores an older notebook response after the selected Project changes", async () => {
  // Given
  const projectA = deferred<NotebookResponse>()
  const projectB = deferred<NotebookResponse>()
  const client: ProjectKbClient = {
    getNotebook: (projectId) => (projectId === "project-a" ? projectA.promise : projectB.promise),
    createNotebook: async () => NOTEBOOK,
    listPages: async () => [],
    getPage: async () => PAGE,
    createPage: async () => PAGE,
    savePage: async () => PAGE,
  }
  const container = document.createElement("div")
  const root = createRoot(container)

  // When
  await act(async () => {
    root.render(<ProjectNotebook client={client} projectId="project-a" projectName="Album A" />)
  })
  await act(async () => {
    root.render(<ProjectNotebook client={client} projectId="project-b" projectName="Album B" />)
    projectB.resolve({ projectId: "project-b", notebook: null })
  })
  await act(async () => {
    projectA.resolve({ projectId: "project-a", notebook: NOTEBOOK })
  })

  // Then
  expect(container.textContent).toContain("Album B")
  expect(container.textContent).toContain("Create library")
  expect(container.textContent).not.toContain("Album library")
  act(() => root.unmount())
})

test("the default editor saves changed text without dropping block metadata", async () => {
  // Given
  const saves: SaveDocument[] = []
  const client: ProjectKbClient = {
    getNotebook: async () => ({ projectId: "project-a", notebook: NOTEBOOK }),
    createNotebook: async () => NOTEBOOK,
    listPages: async () => [PAGE],
    getPage: async () => PAGE,
    createPage: async () => PAGE,
    savePage: async (input) => {
      saves.push(input)
      return { ...PAGE, revision: 4, title: input.title, document: input.document }
    },
  }
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () => {
    root.render(<ProjectNotebook client={client} projectId="project-a" projectName="Album A" />)
  })
  const editor = container.querySelector("textarea")
  const save = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Save document",
  )

  // When
  await act(async () => {
    if (editor !== null) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        editor,
        "Second pass",
      )
      editor.dispatchEvent(new Event("input", { bubbles: true }))
    }
  })
  await act(async () => {
    save?.click()
  })

  // Then
  expect(saves[0]?.document.blocks[0]).toEqual({
    id: "heading-1",
    type: "heading",
    text: "Second pass",
    children: [],
    level: 2,
    language: "music-cue",
  })
  act(() => root.unmount())
})
