/** Telling the owner: what the MCP door's writes read of it (#456, ADR 0028). The rest of `notifier`
 *  is held by its callers' suites, and by the Python's `tests/test_notify.py`. */
import { describe, expect, it, vi } from "vitest";

import { settingsFor } from "./env.ts";
import { delivery, notifier } from "./notify.ts";

const CONFIGURED = settingsFor({ telegramBotToken: "t", telegramChatId: "42" });

describe("delivery", () => {
  it("says which of the three happened: sent, Telegram unconfigured, or failed", async () => {
    const quiet = vi.spyOn(console, "info").mockImplementation(() => {});
    const loud = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sent: string[] = [];
      expect(await delivery(CONFIGURED, (t) => { sent.push(t); })("hello")).toBe("sent");
      expect(await delivery(settingsFor(), (t) => { sent.push(t); })("again")).toBe("unconfigured");
      expect(sent).toEqual(["hello"]);
      expect(await delivery(CONFIGURED, () => { throw new Error("down"); })("hello")).toBe("failed");
      // and `notifier` is it, read as delivered or not: unconfigured counts as delivered
      expect(await notifier(settingsFor(), () => {})("x")).toBe(true);
      expect(await notifier(CONFIGURED, () => Promise.reject(new Error("down")))("x")).toBe(false);
    } finally {
      quiet.mockRestore();
      loud.mockRestore();
    }
  });
});
