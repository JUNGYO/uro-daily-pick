import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeContent, visibleContent } from "./contentReading";
vi.mock("./supabase", () => ({ supabase: { rpc: vi.fn() } }));
let element, stop, send;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  element = document.createElement("article");
  document.body.appendChild(element);
  element.getBoundingClientRect = () => ({
    top: 0,
    bottom: 400,
    height: 400,
    left: 0,
    right: 400,
    width: 400,
  });
  send = vi.fn().mockResolvedValue(null);
});
afterEach(() => {
  stop?.();
  stop = null;
  element.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const run = (ms) => vi.advanceTimersByTimeAsync(ms);
it("does not count an automatic pane until the reader interacts with its content", async () => {
  stop = observeContent({ getElement: () => element, requiresIntent: true, send });
  await run(30000);
  expect(send).not.toHaveBeenCalled();
  element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  await run(2000);
  expect(send).toHaveBeenLastCalledWith(0, []);
  await run(30000);
  expect(send.mock.calls.at(-1)[0]).toBe(30);
  expect(send.mock.calls.at(-1)[1].length).toBeGreaterThan(0);
});
it("does not count unavailable or invisible content, background time or inactive windows", async () => {
  stop = observeContent({ getElement: () => null, send });
  await run(60000);
  expect(send).not.toHaveBeenCalled();
  stop();
  element.hidden = true;
  stop = observeContent({ getElement: () => element, send });
  await run(2000);
  expect(send).not.toHaveBeenCalled();
  element.hidden = false;
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  await run(60000);
  expect(send).not.toHaveBeenCalled();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await run(5000);
  expect(send).not.toHaveBeenCalled();
});
it("clips below-the-fold content and excludes fast scrolling from active reading", async () => {
  element.getBoundingClientRect = () => ({
    top: 5000,
    bottom: 5400,
    height: 400,
    left: 0,
    right: 400,
    width: 400,
  });
  expect(visibleContent(element)).toBe(null);
  element.getBoundingClientRect = () => ({
    top: 0,
    bottom: 400,
    height: 400,
    left: 0,
    right: 400,
    width: 400,
  });
  stop = observeContent({ getElement: () => element, send });
  await run(2000);
  for (let i = 0; i < 40; i++) {
    await run(500);
    document.dispatchEvent(new Event("scroll"));
  }
  expect(send.mock.calls.at(-1)[0]).toBe(0);
  await run(16000);
  expect(send.mock.calls.at(-1)[0]).toBe(15);
});
it("bounds idle accumulation, snapshots cumulative time and tolerates failed writes", async () => {
  stop = observeContent({ getElement: () => element, send });
  await run(2000);
  await run(120000);
  expect(send.mock.calls.at(-1)[0]).toBeLessThanOrEqual(90);
  const calls = send.mock.calls.length;
  await run(60000);
  expect(send).toHaveBeenCalledTimes(calls);
  stop();
  await run(0);
  send.mockReset().mockRejectedValue(new Error("offline"));
  stop = observeContent({ getElement: () => element, send });
  await run(60000);
  expect(send.mock.calls.every(([seconds]) => seconds === 0)).toBe(true);
});
