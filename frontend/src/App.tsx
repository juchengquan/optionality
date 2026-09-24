import { useEffect, useState } from "react";

/** Phase 1 proves the pipeline only: compile, serve through the prefix, reach the API. */
export function App({ rootPath }: { rootPath: string }) {
  const [health, setHealth] = useState<string>("checking…");

  useEffect(() => {
    fetch(`${rootPath}/health`)
      .then((r) => r.json())
      .then((d) => setHealth(d.opend ? "OpenD up" : "OpenD DOWN"))
      .catch((e: unknown) => setHealth(`unreachable: ${String(e)}`));
  }, [rootPath]);

  return (
    <main>
      <h2>optionality — React</h2>
      <p>
        Build pipeline is live. Serving under <code>{rootPath || "/"}</code>. API says: {health}.
      </p>
    </main>
  );
}
