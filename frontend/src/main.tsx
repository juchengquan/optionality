import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Page } from "./Page";
import { PageBoundary } from "./PageBoundary";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <PageBoundary>
      <Page />
    </PageBoundary>
  </StrictMode>,
);
