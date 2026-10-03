import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: mock }));
import { useReaderVisits } from "./useReaderVisits";
function Probe({ user }) { useReaderVisits(user); return null; }
let hidden, online;
beforeEach(() => {
  vi.useFakeTimers();
  mock.rpc.mockReset().mockResolvedValue({data:null,error:null});
  hidden=vi.spyOn(document,"hidden","get").mockReturnValue(false);
  online=vi.spyOn(navigator,"onLine","get").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("records a restored session and visible activity, not polling or background time", async () => {
  render(<Probe user={{id:"reader"}} />);
  await act(async()=>{});
  expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("record_reader_visit");
  await act(async()=>{ window.dispatchEvent(new Event("pointerdown")); vi.advanceTimersByTime(65000); });
  expect(mock.rpc).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(true);
  await act(async()=>window.dispatchEvent(new Event("scroll")));
  expect(mock.rpc).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false);
  await act(async()=>document.dispatchEvent(new Event("visibilitychange")));
  expect(mock.rpc).toHaveBeenCalledTimes(2);
  await act(async()=>{vi.advanceTimersByTime(65000); window.dispatchEvent(new Event("keydown"));});
  expect(mock.rpc).toHaveBeenCalledTimes(3);
});
it("does not record offline identity or signed-out activity and cleans up account listeners", async()=>{
  const view=render(<Probe user={{id:"offline",offline:true}} />);
  expect(mock.rpc).not.toHaveBeenCalled();
  view.rerender(<Probe user={{id:"first"}} />);
  await act(async()=>{});
  view.rerender(<Probe user={{id:"second"}} />);
  await act(async()=>{});
  expect(mock.rpc).toHaveBeenCalledTimes(2);
  view.rerender(<Probe user={null} />);
  await act(async()=>{vi.advanceTimersByTime(65000);window.dispatchEvent(new Event("pointerdown"));});
  expect(mock.rpc).toHaveBeenCalledTimes(2);
});
it("retries a failed visit on later real activity and does not send offline requests",async()=>{
  online.mockReturnValue(false);
  render(<Probe user={{id:"reader"}} />);
  expect(mock.rpc).not.toHaveBeenCalled();
  online.mockReturnValue(true);
  mock.rpc.mockResolvedValueOnce({data:null,error:new Error("network")});
  await act(async()=>window.dispatchEvent(new Event("online")));
  await act(async()=>{vi.advanceTimersByTime(10000);window.dispatchEvent(new Event("focus"));});
  expect(mock.rpc).toHaveBeenCalledTimes(1);
  await act(async()=>{vi.advanceTimersByTime(5000);window.dispatchEvent(new Event("focus"));});
  expect(mock.rpc).toHaveBeenCalledTimes(2);
});
