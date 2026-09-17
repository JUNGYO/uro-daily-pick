import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import CollectionOverview, { ProcessingHealth } from "./CollectionOverview";
afterEach(cleanup);

const localReport = (overrides = {}) => ({
  available: true,
  stale: false,
  reported_at: new Date().toISOString(),
  local_papers: 200,
  synced_papers: 100,
  citation_pending: 100,
  local_originals: 35,
  local_summaries: 18,
  pending_originals: 26,
  pending_summaries: 14,
  sync_state: "capacity_blocked",
  ...overrides,
});

it("distinguishes durable local collection and pending publication from actual service counts", () => {
  render(
    <CollectionOverview
      catalog={{
        automatic_papers: 100,
        originals_acquired: 9,
        summaries_ready: 4,
        local_catalog: localReport(),
      }}
    />,
  );
  const local = screen.getByRole("region", { name: "수집 및 동기화" });
  expect(within(local).getByText("로컬 수집 완료").parentElement).toHaveTextContent("200편");
  expect(within(local).getByText("서비스 동기화 완료").parentElement).toHaveTextContent("100편");
  expect(within(local).getByText("서지정보 동기화 대기").parentElement).toHaveTextContent("100편");
  expect(local).toHaveTextContent("서비스 반영 대기: 원문 확보 정보 26편 · 본문 요약 14편");
  expect(screen.getByRole("meter", { name: "등록 문헌 중 원문 확보율" })).toHaveAttribute(
    "aria-valuenow",
    "9",
  );
  expect(screen.getByText("서비스 반영 현황")).toBeVisible();
  expect(document.body).not.toHaveTextContent(/Z8|Spark|Qwen/);
});

it("explains stored local work at capacity without claiming a live collector from a sync heartbeat", () => {
  render(
    <CollectionOverview
      catalog={{
        local_catalog: localReport(),
        storage: { database_bytes: 453 * 1048576, budget_bytes: 450 * 1048576 },
      }}
    />,
  );
  expect(
    screen.getByText("저장공간 한도로 서비스 동기화가 대기 중입니다. 로컬에 저장된 자료는 보관됩니다."),
  ).toBeVisible();
  expect(document.body).not.toHaveTextContent("로컬 수집은 계속");
});

it("retains reported counts with a stale label and never infers current collection from old or future reports", () => {
  const view = render(<CollectionOverview catalog={{ local_catalog: localReport({ stale: true }) }} />);
  expect(screen.getByText(/최근 수집 상태를 확인할 수 없습니다/)).toBeVisible();
  expect(screen.getByText("로컬 수집 완료").parentElement).toHaveTextContent("200편");
  for (const reported_at of [
    new Date(Date.now() - 3 * 3600000).toISOString(),
    "invalid",
    new Date(Date.now() + 3600000).toISOString(),
  ]) {
    view.rerender(<CollectionOverview catalog={{ local_catalog: localReport({ reported_at }) }} />);
    expect(screen.getByText(/최근 수집 상태를 확인할 수 없습니다/)).toBeVisible();
    expect(screen.queryByText(/저장공간 확보 후 동기화 예정/)).not.toBeInTheDocument();
  }
});

it("does not invent local counts when no worker has reported", () => {
  render(
    <CollectionOverview
      catalog={{ automatic_papers: 100, local_catalog: { available: false, stale: true } }}
    />,
  );
  expect(screen.queryByRole("region", { name: "수집 및 동기화" })).not.toBeInTheDocument();
  expect(screen.queryByText("로컬 수집 완료")).not.toBeInTheDocument();
});

it("shows the server-provided journal target separately from actual collection counts", () => {
  render(
    <CollectionOverview
      catalog={{
        automatic_papers: 100,
        originals_acquired: 9,
        summaries_ready: 4,
        scope: { target_journals: 65, urology_journals: 51, ancillary_journals: 14 },
      }}
    />,
  );
  expect(screen.getByText("수집 대상 65개 저널")).toBeVisible();
  expect(screen.getByText("비뇨의학 관련 51개 · 종양학·종합의학 14개")).toBeVisible();
  expect(screen.getByRole("meter", { name: "등록 문헌 중 원문 확보율" })).toHaveAttribute(
    "aria-valuenow",
    "9",
  );
  expect(screen.getByRole("meter", { name: "확보 원문 중 요약 완료율" })).toHaveAttribute(
    "aria-valuetext",
    "4 / 9편",
  );
});

it("omits missing scope totals and never supplies a hardcoded journal count", () => {
  const { rerender } = render(<CollectionOverview catalog={{ automatic_papers: 100 }} />);
  expect(screen.queryByText(/수집 대상 .*개 저널/)).not.toBeInTheDocument();
  rerender(
    <CollectionOverview
      catalog={{ scope: { target_journals: 12, urology_journals: 8, ancillary_journals: 4 } }}
    />,
  );
  expect(screen.getByText("수집 대상 12개 저널")).toBeVisible();
  expect(screen.getByText("비뇨의학 관련 8개 · 종양학·종합의학 4개")).toBeVisible();
  expect(screen.queryByText(/65개 저널/)).not.toBeInTheDocument();
});

it("shows a valid target without inventing an absent or inconsistent group breakdown", () => {
  const { rerender } = render(<CollectionOverview catalog={{ scope: { target_journals: 65 } }} />);
  expect(screen.getByText("수집 대상 65개 저널")).toBeVisible();
  expect(screen.queryByText(/비뇨의학 관련/)).not.toBeInTheDocument();
  rerender(
    <CollectionOverview
      catalog={{ scope: { target_journals: 65, urology_journals: 51, ancillary_journals: 99 } }}
    />,
  );
  expect(screen.queryByText(/비뇨의학 관련/)).not.toBeInTheDocument();
  rerender(<CollectionOverview catalog={{ scope: { target_journals: -1 } }} />);
  expect(screen.queryByText(/수집 대상 .*개 저널/)).not.toBeInTheDocument();
});

it("separates citation records from acquisition and summarizes only acquired originals", () => {
  render(
    <CollectionOverview
      catalog={{ automatic_papers: 100, originals_acquired: 9, summaries_ready: 4, qwen_summaries: 3 }}
    />,
  );
  expect(screen.getByRole("meter", { name: "등록 문헌 중 원문 확보율" })).toHaveAttribute(
    "aria-valuenow",
    "9",
  );
  expect(screen.getByRole("meter", { name: "확보 원문 중 요약 완료율" })).toHaveAttribute(
    "aria-valuetext",
    "4 / 9편",
  );
  expect(screen.getByText("원문 미확보")).toHaveTextContent("91편");
  expect(screen.getByText("원문 확보·요약 미제공")).toHaveTextContent("5편");
  expect(document.body).not.toHaveTextContent(/Qwen|Spark|Z8|전체 목록|1866|메타데이터/);
});

it("shows missing measurements as unknown and does not invent zeros or a completed percentage", () => {
  render(<CollectionOverview catalog={{ catalog_papers: 138225 }} />);
  expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/0편|100%|정상/);
  expect(document.body).toHaveTextContent("집계 대기");
});

it("reports capacity pause separately from processing health and hides machine names", () => {
  render(
    <>
      <CollectionOverview
        catalog={{ storage: { database_bytes: 453 * 1048576, budget_bytes: 450 * 1048576 } }}
      />
      <ProcessingHealth
        workers={[{ name: "Z8", state: "running", last_seen_at: new Date().toISOString() }]}
      />
    </>,
  );
  expect(screen.getByRole("meter", { name: "서비스 DB 사용량 사용률" })).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  expect(screen.getByText(/새 문헌 정보 등록이 일시 중지/)).toBeVisible();
  expect(screen.getByText("처리 중")).toBeVisible();
  expect(document.body).not.toHaveTextContent("Z8");
});
