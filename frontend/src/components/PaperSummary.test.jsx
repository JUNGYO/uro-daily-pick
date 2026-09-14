import { it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import PaperSummary from "./PaperSummary";

it("shows exactly three numbered lines only for a verified full-text summary", () => {
  render(
    <PaperSummary
      paper={{
        summary_ko: "목적과 설계.\n주요 결과.\n연구 한계.",
        summary_basis: "fulltext",
        fulltext_available: true,
        summary_source_hash: "hash",
        summary_model: "model",
        summarized_at: "2026-09-13",
      }}
    />,
  );
  const section = screen.getByRole("region", { name: "본문 기반 세 줄 요약" });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["목적과 설계.", "주요 결과.", "연구 한계."]);
});

it("keeps the summary section visible when no full text exists", () => {
  render(
    <PaperSummary
      paper={{ summary_ko: "기존 초록 요약.", summary_basis: "abstract", fulltext_available: false }}
    />,
  );
  expect(screen.getByText("원문이 아직 확보되지 않아 본문 기반 요약을 제공할 수 없습니다.")).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  expect(screen.getByText("기존 요약 보기 · 초록 기반")).toBeVisible();
});

it("does not present a mislabeled or incomplete summary as ready", () => {
  render(
    <PaperSummary
      paper={{ summary_ko: "한 줄만 존재.", summary_basis: "fulltext", fulltext_available: true }}
    />,
  );
  expect(screen.getByText("원문은 확보됐지만 본문 기반 요약이 아직 생성되지 않았습니다.")).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
