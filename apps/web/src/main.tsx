import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app/App.tsx"
import "./styles/tokens.css"
import "./styles/base.css"
import "./styles/components.css"
import "./styles/layout.css"
import "./styles/responsive.css"

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab")
  void import("react-scan")
}

const root = document.getElementById("root")
if (root === null) throw new TypeError("missing application root")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
