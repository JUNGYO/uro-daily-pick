import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const api = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), reasons: {} }));
vi.mock("../lib/supabase", () => ({ supabase: { from: api.from } }));
vi.mock("../lib/workspace", () => ({ rpc: api.rpc, paperLink: (paper) => `/papers/${paper.pmid}` }));
import { HeatmapTable, PaperResults, InterestExpansion } from "./InsightsPanels";

const paper = {
  id: 1,
  pmid: "12345",
  title: "Prostate trial",
  journal: "Urology",
  keywords: ["prostate cancer"],
  mesh_terms: ["Prostatic Neoplasms"],
};
const qualified = {
  personalization_enabled: true,
  network: {
    status: "qualified",
    cohort_size: 4,
    min_similar_readers: 3,
    min_paper_support: 3,
    topics: [{ id: "robotics", label: "Robotics", reader_support: 3, paper_support: 2, source: "metadata" }],
  },
  reasons: [
    { type: "keyword", label: "prostate cancer" },
    { type: "similar_readers", label: "qualified", support: 3, cohort_size: 4 },
  ],
};

beforeEach(() => {
  api.reasons = qualified;
  api.rpc.mockReset().mockResolvedValue([{ ...paper, reason: "Profile interests" }]);
  api.from.mockImplementation((table) => {
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      limit: () => q,
      then: (resolve) =>
        Promise.resolve({
          data: table === "papers" ? [paper] : [{ paper_id: 1, reasons: api.reasons }],
        }).then(resolve),
    };
    return q;
  });
});
function expansion(personalized = true) {
  return (
    <MemoryRouter>
      <InterestExpansion userId="own-user" personalized={personalized} returnTo="/insights?activity=read" />
    </MemoryRouter>
  );
}

it("connects keyboard calendar selections to their exact dates", async () => {
  const selected = vi.fn(),
    user = userEvent.setup();
  render(
    <HeatmapTable
      weeks={1}
      months={[{ label: "Sep", span: 1 }]}
      cells={[{ date: "2026-09-14", count: 2 }, null, null, null, null, null, null]}
      activity="Viewed"
      selected=""
      onSelect={selected}
    />,
  );
  screen.getByRole("button", { name: "2026-09-14: 2 viewed papers" }).focus();
  await user.keyboard("{Enter}");
  expect(selected).toHaveBeenCalledWith("2026-09-14");
});

it("exposes exact paper links and the current reader's note and tags", () => {
  render(
    <MemoryRouter>
      <PaperResults
        entries={[{ paper, state: { note: "My trial note", tags: ["screening"] }, events: { read: [null] } }]}
        activity="read"
        period="all"
        today="2026-09-16"
        title="Marked read papers"
        returnTo="/insights?period=all"
        limit={20}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole("link", { name: "Prostate trial" })).toHaveAttribute("href", "/papers/12345");
  expect(screen.getByText(/My trial note/)).toBeVisible();
  expect(screen.getByText("screening")).toBeVisible();
  expect(screen.getByText(/Date not recorded/)).toBeVisible();
});

it("shows only qualified aggregate evidence and hides it immediately on opt out", async () => {
  const view = render(expansion());
  expect(await screen.findByText(/Liked by 3 similar readers \(group: 4\)/)).toBeVisible();
  expect(screen.getByRole("link", { name: /Robotics · 3 readers/ })).toHaveAttribute(
    "href",
    "/discover?q=robotics",
  );
  api.rpc.mockImplementation(() => new Promise(() => {}));
  view.rerender(expansion(false));
  expect(screen.queryByText(/Liked by 3 similar readers/)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Robotics/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Prostate trial" })).not.toBeInTheDocument();
  expect(screen.getByText(/Behavior-based personalization is off/)).toBeVisible();
});

it("never invents a cohort from unsupported or historical recommendation reasons", async () => {
  api.reasons = {
    reasons: [{ type: "similar_readers", label: "Unverified readers", support: 9 }],
    matched_terms: ["prostate cancer"],
  };
  render(expansion());
  await waitFor(() => expect(screen.getByRole("link", { name: "Prostate trial" })).toBeVisible());
  expect(screen.getByText(/Not enough verified similar-reader evidence/)).toBeVisible();
  expect(screen.queryByText(/Unverified readers/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Liked by/)).not.toBeInTheDocument();
});
