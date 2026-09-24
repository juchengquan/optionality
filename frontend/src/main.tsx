import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

// root_path is injected by the Jinja shell: behind `tailscale serve --set-path /opt` the
// browser sees /opt/... while the app sees /..., so every URL has to be built from it.
declare global {
  interface Window {
    OPTIONALITY_ROOT: string;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from the shell");

createRoot(root).render(
  <StrictMode>
    <App rootPath={window.OPTIONALITY_ROOT ?? ""} />
  </StrictMode>,
);
