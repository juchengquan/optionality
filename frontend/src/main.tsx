import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Next } from "./Next";
import { PageBoundary } from "./PageBoundary";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <PageBoundary>
      <Next />
    </PageBoundary>
  </StrictMode>,
);
