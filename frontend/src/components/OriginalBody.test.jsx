import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import OriginalBody from "./OriginalBody";
import { sourceLocations } from "../lib/originalText";

afterEach(cleanup);
test("duplicate XML section labels share one heading and retain both evidence anchors", () => {
  const content = "Results\nResults\nBody.\nResults\nEnd.";
  let start = 0;
  const ranges = content.split("\n").map((text) => {
    const range = { start, end: start + text.length, kind: text === "Results" ? "heading" : "paragraph" };
    start = range.end + 1;
    return range;
  });
  const blocks = ranges.map((range) => ({
    ...range,
    id: `p-${String(range.start).padStart(7, "0")}`,
    text: content.slice(range.start, range.end),
  }));
  const article = { content_text: content, blocks, figures: [], reading_layout: { blocks: ranges } };
  const { container } = render(<OriginalBody article={article} activeId="p-0000008" />);
  const headings = screen.getAllByRole("heading", { name: "Results" });
  expect(headings).toHaveLength(2);
  expect(headings[0]).toContainElement(container.querySelector("#p-0000000"));
  expect(headings[0]).toContainElement(container.querySelector("#p-0000008"));
  expect(headings[0]).toHaveClass("bg-amber-100");
  expect(container).toHaveTextContent("Body.");
  expect(container).toHaveTextContent("End.");
  expect(article.content_text).toBe(content);
});

test("reader joins locator chunks inline, keeps missing text and preserves navigation", () => {
  const content =
    "The decision remained entirely with the clinician.\nFigure 1. A complete caption.\nEnd of document.";
  const cut = content.indexOf("entirely") + 7;
  const figureStart = content.indexOf("Figure 1");
  const figureEnd = content.indexOf("\n", figureStart);
  const block = (start, end, kind = "p") => ({
    id: `${kind}-${String(start).padStart(7, "0")}`,
    start,
    end,
    text: content.slice(start, end),
  });
  const raw = [block(0, cut), block(cut, figureStart - 1), block(figureStart, figureEnd, "figure")];
  const onFigure = vi.fn();
  const figure = { key: "figure-1", label: "Figure 1" };
  const article = { content_text: content, blocks: sourceLocations(content, raw), figures: [figure] };
  const { container } = render(<OriginalBody article={article} activeId={raw[1].id} onFigure={onFigure} />);
  const paragraphs = container.querySelectorAll(".original-paragraph");
  expect(paragraphs).toHaveLength(3);
  expect([...paragraphs].map((p) => p.textContent).join("\n")).toBe(content);
  expect(paragraphs[0].textContent).toContain("entirely with");
  expect(container.querySelector(`#${raw[1].id}`).tagName).toBe("SPAN");
  expect(container.querySelector(`#${raw[1].id}`).getAttribute("tabindex")).toBe("-1");
  fireEvent.click(screen.getByRole("button", { name: "이 그림 보기" }));
  expect(onFigure).toHaveBeenCalledWith(figure);
});
