import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRefreshingResource } from "./useRefreshingResource";

let visibility;
const flush = () => act(async () => {});
beforeEach(() => {
  vi.useFakeTimers();
  visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes in the background without removing the current graph data", async () => {
  let complete;
  const load = vi
    .fn()
    .mockResolvedValueOnce({ count: 15 })
    .mockImplementationOnce(() => new Promise((r) => (complete = r)));
  const { result } = renderHook(() => useRefreshingResource(load, []));
  await flush();
  const checked = result.current.checkedAt;
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(result.current.data.count).toBe(15);
  expect(result.current.loading).toBe(false);
  expect(result.current.refreshing).toBe(true);
  await act(async () => complete({ count: 16 }));
  expect(result.current.data.count).toBe(16);
  expect(result.current.checkedAt.getTime()).toBeGreaterThan(checked.getTime());
});

it("pauses while hidden and refreshes when the page becomes visible", async () => {
  const load = vi.fn().mockResolvedValue({ count: 15 });
  renderHook(() => useRefreshingResource(load, []));
  await flush();
  visibility.mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(() => vi.advanceTimersByTimeAsync(90000));
  expect(load).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(load).toHaveBeenCalledTimes(2);
});

it("does not overlap requests when refreshing or becoming visible", async () => {
  let complete;
  const load = vi.fn(() => new Promise((r) => (complete = r)));
  const { result } = renderHook(() => useRefreshingResource(load, []));
  act(() => {
    result.current.reload();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(() => vi.advanceTimersByTimeAsync(90000));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => complete({ count: 15 }));
  expect(result.current.data.count).toBe(15);
});

it("ignores a late response from a previous filter or account", async () => {
  let oldResponse;
  const load = vi.fn((key) =>
    key === "old" ? new Promise((r) => (oldResponse = r)) : Promise.resolve({ key }),
  );
  const { result, rerender } = renderHook(({ key }) => useRefreshingResource(() => load(key), [key]), {
    initialProps: { key: "old" },
  });
  rerender({ key: "new" });
  await flush();
  await act(async () => oldResponse({ key: "old" }));
  expect(result.current.data).toEqual({ key: "new" });
});

it("keeps the last successful result on a transient refresh failure and recovers", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce({ count: 15 })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ count: 16 });
  const { result } = renderHook(() => useRefreshingResource(load, []));
  await flush();
  const checked = result.current.checkedAt;
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(result.current.data.count).toBe(15);
  expect(result.current.error).toBe("");
  expect(result.current.refreshError).toBe("offline");
  expect(result.current.checkedAt).toEqual(checked);
  await act(async () => result.current.reload());
  expect(result.current.data.count).toBe(16);
  expect(result.current.refreshError).toBe("");
});

it("removes retained data if reader authorization is lost", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce({ count: 15 })
    .mockRejectedValueOnce({ code: "42501", message: "denied" });
  const { result } = renderHook(() => useRefreshingResource(load, []));
  await flush();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(result.current.data).toBeNull();
  expect(result.current.error).toBe("denied");
});

it("stops polling when the page unmounts", async () => {
  const load = vi.fn().mockResolvedValue({ count: 15 });
  const { unmount } = renderHook(() => useRefreshingResource(load, []));
  await flush();
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(90000));
  expect(load).toHaveBeenCalledTimes(1);
});
