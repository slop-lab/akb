// @ts-check
import { copyFile } from "node:fs/promises"

await copyFile(
  new URL("../src/react/styles.css", import.meta.url),
  new URL("../dist/react/styles.css", import.meta.url),
)
