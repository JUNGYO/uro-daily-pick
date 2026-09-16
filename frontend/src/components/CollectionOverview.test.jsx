import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CollectionOverview, { ProcessingHealth } from "./CollectionOverview";
afterEach(cleanup);

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
