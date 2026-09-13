import { describe, it, expect, vi } from "vitest";
import { allRows, checked, kstDate, shiftDate, normalizeRec, withTimeout } from "./data";

describe("data boundaries", () => {
  it("handles native, legacy, and malformed JSON without rendering objects as text", () => {
    const rec = normalizeRec({
      paper: {
        authors: '["Reader", null]',
        structured_data: '{"sample_size":{"bad":true}}',
        qa_data: "garbage",
      },
      reasons: "null",
    });
    expect(rec.paper.authors).toEqual(["Reader"]);
    expect(rec.paper.structured_data).toEqual({});
    expect(rec.paper.qa_data).toEqual([]);
    expect(rec.reasons.matched_terms).toEqual([]);
  });
  it("uses Korea's date at the UTC boundary and handles month changes", () => {
    expect(kstDate("2026-09-13T15:00:00Z")).toBe("2026-09-14");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("propagates database failures and ends stalled requests", async () => {
    await expect(checked(Promise.resolve({ error: new Error("Unavailable") }))).rejects.toThrow(
      "Unavailable",
    );
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toThrow("timed out");
  });
  it("loads later pages instead of silently accepting the server row limit", async () => {
    const range = vi
      .fn()
      .mockResolvedValueOnce({ data: [1, 2] })
      .mockResolvedValueOnce({ data: [3] });
    expect(await allRows(() => ({ range }), 2)).toEqual([1, 2, 3]);
    expect(range).toHaveBeenLastCalledWith(2, 3);
  });
});
