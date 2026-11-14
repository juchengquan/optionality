/** The redesigned page's press that saves it as an image (#300), as a sequence: `/opt`'s
 *  `UseSnapshot.test.tsx` for `next/snapshot/useSaveImage.ts`. What a picture LOOKS like is the
 *  browser suite's (`__browser__/NextSnapshot*.test.tsx`); this is what the press does on every
 *  path the browser suite never takes — a capture that fails, a page that goes mid-capture, a
 *  device with no share sheet, and a second press — none of which leaves a PNG to look at.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toBlob = vi.fn();
vi.mock("html-to-image", () => ({ toBlob: (...a: unknown[]) => toBlob(...a) }));

const added: { title: string; type?: string }[] = [];
vi.mock("@/components/ui/toast", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/toast")>()),
  toast: { add: (t: { title: string; type?: string }) => added.push(t) },
}));

const delivered: string[] = [];
let delivery: "shared" | "downloaded" | "cancelled" = "shared";
vi.mock("../shared/snapshot", async (orig) => ({
  ...(await orig<typeof import("../shared/snapshot")>()),
  deliver: (_blob: Blob, name: string) => {
    delivered.push(name);
    return Promise.resolve(delivery);
  },
}));

const { useSaveImage } = await import("../snapshot/useSaveImage");
const { Next } = await import("../Next");

/** A promise the test settles: the capture, held in flight. */
function pending<T>() {
  let settle!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { settle = res; fail = rej; });
  return { promise, settle, fail };
}

/** The stage as the page mounts it while a picture is taken: a wrapper holding the still's root. */
function mountStage(ref: { current: HTMLDivElement | null }): HTMLElement {
  const stage = document.createElement("div");
  const inner = document.createElement("div");
  inner.className = "nx-still";
  stage.append(inner);
  document.body.append(stage);
  ref.current = stage;
  return inner;
}

beforeEach(() => {
  added.length = 0;
  delivered.length = 0;
  delivery = "shared";
  toBlob.mockReset();
  toBlob.mockResolvedValue(new Blob(["png"]));
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("the press", () => {
  it("holds the page's figures from the press, and lets them go when it is done", async () => {
    const { result } = renderHook(() => useSaveImage<{ n: number }>());
    expect(result.current.frame).toBeNull();
    const capture = pending<Blob>();
    toBlob.mockReturnValue(capture.promise);
    let done!: Promise<void>;
    act(() => {
      mountStage(result.current.stageRef);
      done = result.current.save({ n: 1 });
    });
    expect(result.current.frame).toEqual({ n: 1 });
    await waitFor(() => expect(toBlob).toHaveBeenCalled());
    await act(async () => { capture.settle(new Blob(["png"])); await done; });
    expect(result.current.frame).toBeNull();
    expect(delivered).toHaveLength(1);
  });

  it("captures the still's root, not the stage around it", async () => {
    const { result } = renderHook(() => useSaveImage<object>());
    let inner!: HTMLElement;
    await act(async () => {
      inner = mountStage(result.current.stageRef);
      await result.current.save({});
    });
    expect(toBlob.mock.calls[0]![0]).toBe(inner);
  });

  it("says why, and takes the tree down, when the capture fails", async () => {
    toBlob.mockRejectedValue(new Error("the canvas refused"));
    const { result } = renderHook(() => useSaveImage<object>());
    await act(async () => {
      mountStage(result.current.stageRef);
      await result.current.save({});
    });
    expect(result.current.frame, "the tree is still up after a failed capture").toBeNull();
    expect(added).toEqual([{ title: "the canvas refused", type: "error" }]);
    expect(delivered).toEqual([]);
  });

  it("words a failure that is not an Error, rather than printing [object Event]", async () => {
    // html-to-image rejects with the DOM Event of an <img> that would not decode its SVG
    toBlob.mockRejectedValue(new Event("error"));
    const { result } = renderHook(() => useSaveImage<object>());
    await act(async () => {
      mountStage(result.current.stageRef);
      await result.current.save({});
    });
    expect(added).toEqual([{ title: "the image could not be drawn", type: "error" }]);
  });

  it("says the file was saved where there is no share sheet, and nothing where there is", async () => {
    const { result } = renderHook(() => useSaveImage<object>());
    await act(async () => {
      mountStage(result.current.stageRef);
      await result.current.save({});
    });
    expect(added, "a toast on top of the share sheet").toEqual([]);
    delivery = "downloaded";
    await act(async () => { await result.current.save({}); });
    expect(added).toEqual([{ title: "saved as an image", type: "success" }]);
  });

  it("delivers nothing, and says nothing, for a page that went mid-capture", async () => {
    const capture = pending<Blob>();
    toBlob.mockReturnValue(capture.promise);
    const { result, unmount } = renderHook(() => useSaveImage<object>());
    let done!: Promise<void>;
    act(() => {
      mountStage(result.current.stageRef);
      done = result.current.save({});
    });
    await waitFor(() => expect(toBlob).toHaveBeenCalled());
    unmount();
    await act(async () => { capture.settle(new Blob(["png"])); await done; });
    expect(delivered, "a picture was handed over for a page that has gone").toEqual([]);
    expect(added).toEqual([]);
  });

  it("says nothing either when that capture fails after the page went", async () => {
    const capture = pending<Blob>();
    toBlob.mockReturnValue(capture.promise);
    const { result, unmount } = renderHook(() => useSaveImage<object>());
    let done!: Promise<void>;
    act(() => {
      mountStage(result.current.stageRef);
      done = result.current.save({});
    });
    await waitFor(() => expect(toBlob).toHaveBeenCalled());
    unmount();
    await act(async () => { capture.fail(new Error("late")); await done; });
    expect(added).toEqual([]);
  });

  it("takes one picture for two presses", async () => {
    const capture = pending<Blob>();
    toBlob.mockReturnValue(capture.promise);
    const { result } = renderHook(() => useSaveImage<object>());
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      mountStage(result.current.stageRef);
      first = result.current.save({});
    });
    await waitFor(() => expect(toBlob).toHaveBeenCalled());
    act(() => { second = result.current.save({}); });
    await act(async () => { capture.settle(new Blob(["png"])); await Promise.all([first, second]); });
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
  });
});

describe("the page's button", () => {
  const health = {
    db: true, provider: { name: "moomoo", ok: true },
    monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
    settings: { sweep_seconds: 600, expired_retention_days: 7, manage_by_dte: 21 },
  };

  it("is off while a picture is being taken, and back when it is done", async () => {
    window.fetch = ((url: string) => {
      const path = String(url).replace(/^.*\/api/, "");
      const body = path === "/health" ? health : [];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }) as unknown as typeof fetch;
    const capture = pending<Blob>();
    toBlob.mockReturnValue(capture.promise);
    render(<Next />);
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "save as image" });
    fireEvent.click(button);
    await waitFor(() => expect(toBlob).toHaveBeenCalled());
    expect(button.disabled, "a second press is possible mid-capture").toBe(true);
    expect(document.querySelector(".nx-still-stage .nx-still")).toBeTruthy();
    await act(async () => { capture.settle(new Blob(["png"])); });
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(document.querySelector(".nx-still-stage")).toBeNull();
  });
});
