import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ rpc: vi.fn(), rows: [] }));
vi.mock("./workspace", () => ({ rpc: api.rpc }));
vi.mock("./supabase", () => ({
  supabase: {
    from: (table) => {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        limit: () => q,
        then: (resolve) =>
          Promise.resolve({ data: table === "recommendations" ? api.rows : [], error: null }).then(resolve),
      };
      return q;
    },
  },
}));
import { useDailyReader } from "./useDailyReader";

beforeEach(() => {
  api.rpc.mockReset();
  api.rows = [];
});

test("opting out immediately hides personalized queue and stale reasons during refresh", async () => {
  let releaseQueue;
  let requests = 0;
  api.rows = [{ paper_id: 1, score: 0.9, reasons: { personalization_enabled: true, cf: 0.8 } }];
  api.rpc.mockImplementation((name) => {
    if (name === "reader_daily") {
      requests += 1;
      if (requests === 1) return Promise.resolve([{ id: 1, pmid: "1" }]);
      return new Promise((resolve) => {
        releaseQueue = () => resolve([{ id: 1, pmid: "1" }]);
      });
    }
    return Promise.resolve({ paper: { id: 1, pmid: "1" }, state: { reading_state: "read" } });
  });
  const { result, rerender } = renderHook(
    ({ personalized }) => useDailyReader("reader", "2026-09-15", "1", false, personalized),
    { initialProps: { personalized: true } },
  );
  await waitFor(() => expect(result.current.reasons[1]?.cf).toBe(0.8));
  rerender({ personalized: false });
  expect(result.current.cards).toEqual([]);
  expect(result.current.reasons).toEqual({});
  expect(result.current.scores).toEqual({});
  await waitFor(() => expect(releaseQueue).toBeTypeOf("function"));
  await act(async () => releaseQueue());
  await waitFor(() => expect(result.current.cards).toHaveLength(1));
  expect(result.current.reasons).toEqual({});
});

test("a save accepted during automatic reading waits and stays with its original paper", async () => {
  let releaseReading;
  const saved = {};
  api.rpc.mockImplementation((name, args) => {
    if (name === "reader_daily")
      return Promise.resolve([
        { id: 1, pmid: "1" },
        { id: 2, pmid: "2" },
      ]);
    if (name === "reader_paper")
      return Promise.resolve({
        paper: { id: Number(args.p_pmid), pmid: args.p_pmid },
        state: { saved: false, reading_state: "unread" },
      });
    if (args.p_patch.reading_state === "reading" && args.p_paper_id === 1)
      return new Promise((resolve) => {
        releaseReading = () => resolve({ saved: false, reading_state: "reading" });
      });
    saved[args.p_paper_id] = { ...saved[args.p_paper_id], ...args.p_patch };
    return Promise.resolve({ saved: false, reading_state: "reading", ...saved[args.p_paper_id] });
  });
  const { result, rerender } = renderHook(({ pmid }) => useDailyReader("reader", "2026-09-15", pmid), {
    initialProps: { pmid: "1" },
  });
  await waitFor(() => expect(releaseReading).toBeTypeOf("function"));
  expect(result.current.busy).toBe(false);
  let saving;
  act(() => {
    saving = result.current.change({ saved: true }, "saved");
  });
  rerender({ pmid: "2" });
  await act(async () => {
    releaseReading();
    await saving;
  });
  await waitFor(() => expect(result.current.detail.data?.paper.id).toBe(2));
  expect(result.current.detail.data.state.saved).toBe(false);
  rerender({ pmid: "1" });
  await waitFor(() => expect(result.current.detail.data?.paper.id).toBe(1));
  expect(result.current.detail.data.state.saved).toBe(true);
  expect(saved[1].saved).toBe(true);
  expect(saved[2]?.saved).not.toBe(true);
});
