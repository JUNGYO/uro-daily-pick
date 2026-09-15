import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CollectionOverview, { ProcessingHealth } from "./CollectionOverview";
afterEach(cleanup);

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
  expect(screen.getByText("원문 확보 후 요약 대기")).toHaveTextContent("5편");
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
  expect(screen.getByRole("meter", { name: "문헌 정보 저장공간 사용률" })).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  expect(screen.getByText(/새 문헌 정보 등록이 일시 중지/)).toBeVisible();
  expect(screen.getByText("처리 중")).toBeVisible();
  expect(document.body).not.toHaveTextContent("Z8");
});
