import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"
import { Button } from "./primitives.tsx"

test("busy buttons remain disabled even when callers explicitly pass disabled false", () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let clicks = 0
  try {
    act(() =>
      root.render(
        <Button
          busy
          disabled={false}
          onClick={() => {
            clicks += 1
          }}
        >
          Save
        </Button>,
      ),
    )
    const button = container.querySelector("button")
    expect(button?.disabled).toBe(true)
    button?.click()
    expect(clicks).toBe(0)
    act(() =>
      root.render(
        <Button
          disabled={false}
          onClick={() => {
            clicks += 1
          }}
        >
          Save
        </Button>,
      ),
    )
    expect(button?.disabled).toBe(false)
    button?.click()
    expect(clicks).toBe(1)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
