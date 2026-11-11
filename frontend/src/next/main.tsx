import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Next } from "./Next";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from next/index.html");

createRoot(root).render(
  <StrictMode>
    <Next />
  </StrictMode>,
);
