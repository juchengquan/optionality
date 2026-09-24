import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built assets are COMMITTED and served by FastAPI, so the deployment keeps the property
// that what is in the working tree is what runs — node never sits on the critical path.
// No index.html is emitted: .gitignore's blanket *.html would swallow it, and the shell is
// a Jinja template instead, which is also how root_path reaches the client.
export default defineConfig({
  plugins: [react()],
  build: {
    manifest: true,
    outDir: "../src/optionality/service/static/app",
    emptyOutDir: true,
    rollupOptions: { input: "src/main.tsx" },
  },
});
