import { requireTestValue } from "../../contracts/src/test-support.js";
import {expect, it, vi} from "vitest";
import {withBrowserTreeSpoolCustody, type BrowserTreeSpoolHandleCustody} from "./browser-upload-tree-stream-custody.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}
function fixture() {
  const release = vi.fn(async () => undefined);
  const acquire = vi.fn(async () => ({release}));
  return {release, acquire};
}

it("holds physical exclusion until the awaited data CLOSE finishes", async () => {
  const f = fixture(), closing = deferred<undefined>(), entered = deferred<undefined>();
  const handle = {close: vi.fn(async () => { entered.resolve(undefined); await closing.promise; })};
  const work = withBrowserTreeSpoolCustody(f.acquire, async custody => {
    await custody.open(async () => handle);
    await custody.close(handle);
    return "closed";
  });
  await entered.promise;
  expect(f.release).not.toHaveBeenCalled();
  closing.resolve(undefined);
  await expect(work).resolves.toBe("closed");
  expect(f.release).toHaveBeenCalledTimes(1);
});

it("retains exclusion on CLOSE rejection even if the action catches it", async () => {
  const f = fixture(), handle = {close: vi.fn(async () => { throw Error("close uncertain"); })};
  await expect(withBrowserTreeSpoolCustody(f.acquire, async custody => {
    await custody.open(async () => handle);
    await custody.close(handle).catch(() => undefined);
    return "not a receipt";
  })).rejects.toThrow("close_unconfirmed");
  expect(f.release).not.toHaveBeenCalled();
});

it("keeps the original failure and physical exclusion when CLOSE fails", async () => {
  const f = fixture(), failure = Error("close uncertain"), handle = {close: vi.fn(async () => { throw failure; })};
  await expect(withBrowserTreeSpoolCustody(f.acquire, async custody => {
    await custody.open(async () => handle);
    await custody.close(handle);
  })).rejects.toBe(failure);
  expect(f.release).not.toHaveBeenCalled();
});

it("releases after an operation fails only when its handle is confirmed closed", async () => {
  const f = fixture(), handle = {close: vi.fn(async () => undefined)}, failure = Error("binding rejected");
  await expect(withBrowserTreeSpoolCustody(f.acquire, async custody => {
    await custody.open(async () => handle);
    try { throw failure; } finally { await custody.close(handle); }
  })).rejects.toBe(failure);
  expect(handle.close).toHaveBeenCalledTimes(1);
  expect(f.release).toHaveBeenCalledTimes(1);
});

it("retains exclusion when an action returns with an open descriptor", async () => {
  const f = fixture(), handle = {close: vi.fn(async () => undefined)};
  await expect(withBrowserTreeSpoolCustody(f.acquire, async custody => {
    await custody.open(async () => handle);
  })).rejects.toThrow("close_unconfirmed");
  expect(f.release).not.toHaveBeenCalled();
});

it("retains exclusion for an unjoined open even after it eventually closes", async () => {
  const f = fixture(), opening = deferred<{close(): Promise<void>}>();
  let pending!: Promise<{close(): Promise<void>}>;
  let saved!: BrowserTreeSpoolHandleCustody;
  await expect(withBrowserTreeSpoolCustody(f.acquire, async custody => {
    saved = custody;
    pending = custody.open(() => opening.promise);
  })).rejects.toThrow("close_unconfirmed");
  expect(f.release).not.toHaveBeenCalled();
  opening.resolve({close: async () => undefined});
  await saved.close(await pending);
  expect(f.release).not.toHaveBeenCalled();
});

it("does not enter physical work when another process retains the marker", async () => {
  const action = vi.fn();
  await expect(withBrowserTreeSpoolCustody(async () => { throw Error("custody_retained"); }, action)).rejects.toThrow("custody_retained");
  expect(action).not.toHaveBeenCalled();
});

it("rejects late opens after release and does not invoke the physical opener", async () => {
  const f = fixture(), start = vi.fn(), invalid = {close: vi.fn()}, saved: BrowserTreeSpoolHandleCustody[] = [];
  await withBrowserTreeSpoolCustody(f.acquire, async custody => { saved.push(custody); });
  await expect(requireTestValue(saved[0]).open(start)).rejects.toThrow("custody_finished");
  await expect(requireTestValue(saved[0]).close(invalid)).rejects.toThrow("handle_invalid");
  expect(start).not.toHaveBeenCalled();
  expect(invalid.close).not.toHaveBeenCalled();
});

it("does not return a receipt if marker removal fails after confirmed closure", async () => {
  const f = fixture();
  f.release.mockRejectedValueOnce(Error("marker removal failed"));
  await expect(withBrowserTreeSpoolCustody(f.acquire, async () => "receipt")).rejects.toThrow("marker removal failed");
});
