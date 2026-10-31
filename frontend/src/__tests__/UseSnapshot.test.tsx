/** The press that saves the page as an image, as a sequence.
 *
 *  Three of its steps are ORDER, not arithmetic, and each was a bug once: the holdings are
 *  awaited before the stage is laid out, the stage gets two frames before it is painted, and
 *  the node captured is the inner one rather than the off-screen wrapper. None of that is
 *  visible in a rendered result — the symptom of getting any of it wrong is a PNG, which is
 *  exactly the artefact a test cannot read — so the sequence is asserted here directly.
 *
 *  NOT asserted here: that the off-screen stage is mounted and painted. `shooting` turns on and
 *  off inside one press, so React coalesces the intermediate render away under `act` and jsdom
 *  can see neither the mounted stage nor a pixel of it. That half is asserted end to end against
 *  a real layout engine, on the delivered PNG itself (`__browser__/Snapshot.test.tsx`).
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toBlob = vi.fn();
vi.mock("html-to-image", () => ({ toBlob: (...a: unknown[]) => toBlob(...a) }));

const added: { title: string; type?: string }[] = [];
vi.mock("@/components/ui/toast", () => ({
  toast: { add: (t: { title: string; type?: string }) => added.push(t) },
}));

const delivered: { name: string }[] = [];
let delivery: "shared" | "downloaded" | "cancelled" = "downloaded";
vi.mock("../snapshot", async (orig) => ({
  ...(await orig<typeof import("../snapshot")>()),
  deliver: (_blob: Blob, name: string) => {
    delivered.push({ name });
    return Promise.resolve(delivery);
  },
}));

const { useSnapshot } = await import("../useSnapshot");

/** the off-screen wrapper with the real tree's shape: a stage holding a `.snapshot` */
function mountStage(ref: { current: HTMLDivElement | null }): HTMLElement {
  const stage = document.createElement("div");
  const inner = document.createElement("div");
  inner.className = "snapshot";
  Object.defineProperty(inner, "scrollWidth", { value: 1161 });
  Object.defineProperty(inner, "scrollHeight", { value: 900 });
  stage.append(inner);
  document.body.append(stage);
  ref.current = stage;
  return inner;
}

beforeEach(() => {
  added.length = 0;
  delivered.length = 0;
  delivery = "downloaded";
  toBlob.mockReset();
  toBlob.mockResolvedValue(new Blob(["png"]));
  document.body.innerHTML = "";
});

describe("saving the page as an image", () => {
  it("fetches the holdings BEFORE the stage is laid out", async () => {
    // the one figure in the picture that is not already on screen. Awaited here is what makes
    // the whole image a single instant; fetched after the frames, the stage is laid out without
    // the holdings and they land in the picture at whatever height they were given.
    const order: string[] = [];
    const loadHoldings = vi.fn(async () => { order.push("holdings"); });
    const { result } = renderHook(() => useSnapshot(loadHoldings));
    let inner: HTMLElement | null = null;
    toBlob.mockImplementation(() => { order.push("capture"); return Promise.resolve(new Blob()); });

    await act(async () => {
      inner = mountStage(result.current.stageRef);
      await result.current.saveImage();
    });

    expect(order).toEqual(["holdings", "capture"]);
    expect(inner).not.toBeNull();
  });

  it("captures the inner node, not the off-screen wrapper", async () => {
    // html-to-image copies the captured node's own computed style into the SVG it paints, so
    // capturing the stage carried `position: fixed; left: -10000px` with it and the content
    // landed outside the frame: a blank PNG of exactly the right size.
    const { result } = renderHook(() => useSnapshot(async () => {}));
    let inner: HTMLElement | null = null;
    await act(async () => {
      inner = mountStage(result.current.stageRef);
      await result.current.saveImage();
    });
    expect(toBlob).toHaveBeenCalledOnce();
    expect(toBlob.mock.calls[0]![0]).toBe(inner);
  });

  it("captures the SCROLL size, so figures that overflow are in the picture", async () => {
    const { result } = renderHook(() => useSnapshot(async () => {}));
    await act(async () => {
      mountStage(result.current.stageRef);
      await result.current.saveImage();
    });
    expect(toBlob.mock.calls[0]![1]).toMatchObject({ width: 1161, height: 900 });
  });

  it("says something when the image was saved as a file", async () => {
    const { result } = renderHook(() => useSnapshot(async () => {}));
    await act(async () => {
      mountStage(result.current.stageRef);
      await result.current.saveImage();
    });
    expect(added).toEqual([{ title: "saved as an image", type: "success" }]);
    expect(delivered).toHaveLength(1);
  });

  it("stays quiet when the device's own share sheet took it", async () => {
    // the sheet is its own confirmation; a toast on top of it is noise
    delivery = "shared";
    const { result } = renderHook(() => useSnapshot(async () => {}));
    await act(async () => {
      mountStage(result.current.stageRef);
      await result.current.saveImage();
    });
    expect(added).toEqual([]);
  });

  it("never answers a press with silence", async () => {
    // twice bitten: a button that produces neither a picture nor a word is indistinguishable
    // from a broken one
    toBlob.mockResolvedValue(null);
    const { result } = renderHook(() => useSnapshot(async () => {}));
    await act(async () => {
      mountStage(result.current.stageRef);
      await result.current.saveImage();
    });
    expect(added).toHaveLength(1);
    expect(added[0]!.type).toBe("error");
    await waitFor(() => expect(result.current.shooting).toBe(false));
  });

  it("takes the stage down after a failure too, so the button works again", async () => {
    toBlob.mockRejectedValue(new Error("the canvas gave up"));
    const { result } = renderHook(() => useSnapshot(async () => {}));
    await act(async () => {
      mountStage(result.current.stageRef);
      await result.current.saveImage();
    });
    expect(added[0]).toEqual({ title: "the canvas gave up", type: "error" });
    await waitFor(() => expect(result.current.shooting).toBe(false));
  });

  it("says so rather than going quiet when the stage never appeared", async () => {
    // `return` with nothing said was the old shape: the ref is null if the off-screen tree did
    // not mount, and the press then did nothing at all and reported nothing at all
    const { result } = renderHook(() => useSnapshot(async () => {}));
    await act(async () => { await result.current.saveImage(); });
    expect(toBlob).not.toHaveBeenCalled();
    expect(added).toHaveLength(1);
    expect(added[0]!.type).toBe("error");
  });
});
