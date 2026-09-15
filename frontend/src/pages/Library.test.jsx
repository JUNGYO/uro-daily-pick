import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Library from "./Library";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "reader" } }) }));
vi.mock("../lib/supabase", () => ({
  supabase: {
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        range: () => Promise.resolve({ data: [], error: null }),
      };
      return query;
    },
  },
}));
vi.mock("../lib/workspace", () => ({
  rpc: mocks.rpc,
  cachedPapers: () => [],
  removeCached: vi.fn(),
  paperLink: (paper) => "/papers/" + paper.pmid,
}));

const paper = (id) => ({
  id,
  pmid: String(10000 + id),
  title: "Unsaved research note " + id,
  journal: "Fixture journal",
  pub_date: "2026-01-01",
  summary_ready: false,
  fulltext_available: false,
  saved: false,
  note: "Needle design rationale",
  tags: ["needle-tag"],
});
const open = (url) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Library />
    </MemoryRouter>,
  );
afterEach(cleanup);
beforeEach(() => {
  mocks.rpc.mockResolvedValue({ items: [], total: 0, page: 0 });
});

it("renders note-only RPC records without requiring a saved relationship", async () => {
  mocks.rpc.mockResolvedValue({ items: [paper(1)], total: 1, page: 0 });
  open("/library?tab=notes&q=needle");
  expect(await screen.findByRole("link", { name: "Unsaved research note 1" })).toBeVisible();
  expect(screen.getByText(/Needle design rationale/)).toBeVisible();
  expect(mocks.rpc).toHaveBeenCalledWith("search_library", {
    p_query: "needle",
    p_tab: "notes",
    p_page: 0,
  });
});

it.each(["saved", "liked", "reading", "read"])(
  "retains the %s tab when submitting a memo search",
  async (tab) => {
    open("/library?tab=" + tab);
    const search = screen.getByRole("textbox", { name: "메모·태그 검색" });
    fireEvent.change(search, { target: { value: "needle" } });
    fireEvent.submit(search.closest("form"));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith("search_library", {
        p_query: "needle",
        p_tab: tab,
        p_page: 0,
      }),
    );
  },
);

it("uses the server total for paging and preserves the memo query on the last page", async () => {
  mocks.rpc.mockImplementation(async (_name, args) => ({
    items: Array.from({ length: args.p_page ? 3 : 20 }, (_, i) => paper(i + 1)),
    total: 23,
    page: args.p_page,
  }));
  open("/library?tab=notes&q=needle");
  await screen.findByRole("link", { name: "Unsaved research note 20" });
  fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
  await waitFor(() =>
    expect(mocks.rpc).toHaveBeenLastCalledWith("search_library", {
      p_query: "needle",
      p_tab: "notes",
      p_page: 1,
    }),
  );
  expect(await screen.findByRole("link", { name: "Unsaved research note 3" })).toBeVisible();
  expect(screen.getByRole("button", { name: "다음 페이지" })).toBeDisabled();
  expect(screen.queryByRole("link", { name: "Unsaved research note 20" })).not.toBeInTheDocument();
});
