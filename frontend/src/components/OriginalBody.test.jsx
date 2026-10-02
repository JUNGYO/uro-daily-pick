import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import OriginalBody from "./OriginalBody";
import { readingLayout, sourceLocations } from "../lib/originalText";

afterEach(cleanup);
test("native citations use brackets, retain evidence anchors and open only preserved references", () => {
  const content = "🧬 N = 195, 95% CI. Clinical assessment. 12 Next sentence. 3 Area mm2.";
  const start = content.indexOf("12"),
    end = start + 2,
    missing = content.indexOf("3 Area");
  const offset = (n) => [...content.slice(0, n)].length;
  const layout = readingLayout(content, "source", {
    version: 1,
    content_hash: "source",
    citation_version: 1,
    blocks: [{ kind: "paragraph", start: 0, end: [...content].length }],
    citations: [
      { start: offset(start), end: offset(end), text: "12", targets: ["R12"] },
      { start: offset(missing), end: offset(missing + 1), text: "3", targets: ["R3"] },
    ],
    references: [{ id: "R12", text: "12. Alpha. Clinical study. 2020. <script>literal source</script>" }],
  });
  const cut = start + 1;
  const blocks = sourceLocations(content, [
    { id: "p-0000000", start: 0, end: offset(cut), text: content.slice(0, cut) },
    { id: "p-0000039", start: offset(cut), end: [...content].length, text: content.slice(cut) },
  ]);
  const article = {
    pmid: "123",
    content_hash: "source",
    content_text: content,
    blocks,
    figures: [],
    reading_layout: layout,
  };
  const { container } = render(<OriginalBody article={article} activeId="p-0000039" />);
  expect(container.querySelectorAll("sup.original-citation")).toHaveLength(2);
  expect(container.querySelector(".original-paragraph").textContent).toBe(
    content.replace("12", "[1]").replace("3 Area", "[2] Area"),
  );
  expect(container.querySelectorAll("#p-0000039")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "참고문헌 2 보기" })).toBeNull();
  const button = screen.getByRole("button", { name: "참고문헌 1 보기" });
  fireEvent.click(button);
  const details = screen.getByRole("complementary", { name: "참고문헌 1" });
  expect(details).toHaveTextContent("Alpha. Clinical study.");
  expect(container.querySelector("script")).toBeNull();
  expect(button).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(details, { key: "Escape" });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(button).toHaveFocus();
});
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
