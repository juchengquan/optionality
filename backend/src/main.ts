/** The process. launchd runs this file directly — Node executes TypeScript with no build step,
 *  which keeps the property that what is in the working tree is what runs (ADR 0009). */
import { createApp } from "./app.ts";

const app = createApp();
console.log(`optionality backend: scaffolding only, nothing served (${Object.keys(app).length} key)`);
