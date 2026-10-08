import { render, screen, within, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
vi.mock("../lib/supabase", () => ({ supabase: { rpc: vi.fn() } }));
import { UsageContent } from "./UsageAnalytics";
it("separates successful views, inferred reading and use without showing private contents", () => {
  render(
    <UsageContent
      data={{
        active_users: 4,
        viewing_users: 3,
        engaged_users: 2,
        usage_users: 1,
        returning_users: 2,
        viewed_user_papers: 8,
        used_user_papers: 2,
        measured_since: "2026-10-08T00:00:00Z",
        window_start: "2026-10-08T00:00:00Z",
        daily: [{ day: "2026-10-08", viewing_users: 3, usage_users: 1 }],
        users: [
          {
            name: "Reader",
            summary_papers: 4,
            original_papers: 2,
            engaged_papers: 2,
            active_seconds: 150,
            active_days: 2,
            saves: 1,
            likes: 3,
            notes: 1,
            project_adds: 1,
            screenings: 2,
            extractions: 1,
            exports: 1,
            writing: 0,
            last_activity_at: null,
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("50.0%")).toBeVisible();
  expect(screen.getByText("25.0%")).toBeVisible();
  const table = within(screen.getByRole("table"));
  expect(table.getByText("4편")).toBeVisible();
  fireEvent.click(table.getByText("Reader"));
  expect(table.getByText(/선별 2회/)).toBeVisible();
  fireEvent.click(screen.getByText("집계 기준"));
  expect(screen.getByText(/완독·이해 여부/)).toBeVisible();
  expect(screen.queryByText("100% 읽음")).not.toBeInTheDocument();
});
it("shows no denominator as unavailable, rather than a zero conversion or retention rate", () => {
  render(
    <UsageContent
      data={{
        active_users: 0,
        viewing_users: 0,
        engaged_users: 0,
        usage_users: 0,
        returning_users: 0,
        viewed_user_papers: 0,
        used_user_papers: 0,
        users: [],
        daily: [],
      }}
    />,
  );
  expect(screen.getByText(/수집된 열람·활용 기록이 없습니다/)).toBeVisible();
  expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
});
