// @vitest-environment node
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  adaptResearchWorkspaceExport,
  normalizeResearchExport,
  buildResearchCsv,
  buildResearchRis,
  createResearchDocxBytes,
  researchCslItem,
  zoteroCitationCode,
  zoteroDocumentData,
  getResearchExportCapabilities,
} from "./researchExport";

function snapshot(count = 7) {
  return {
    project: { id: 14, name: "전립선암 연구", description: "추적 관찰 비교" },
    workspace: {
      question: "장기 결과는 어떻게 다른가?",
      columns: [
        { id: "design", label: "연구 설계" },
        { id: "outcome", label: "결과" },
        { id: "limitations", label: "한계" },
        { id: "followup", label: "추적 기간" },
      ],
    },
    references: Array.from({ length: count }, (_, i) => ({
      id: i + 101,
      paper_id: i + 900,
      bibliography: {
        pmid: `${42200001 + i}`,
        title: `한글 연구 ${i + 1} <치료> & "비교"`,
        authors: ["Kim J", "Lee S"],
        journal: "Study Journal",
        pub_date: "2024-03-04",
        doi: `10.1234/example.${i}`,
        volume: "12",
        issue: "3",
        pages: "11-19",
      },
      auto_values: {
        design: "무작위 시험",
        outcome: "자동 결과",
        limitations: "추적 기간 제한",
        followup: "24개월",
      },
      user_values: i === 0 ? { outcome: "사용자 결과", limitations: "" } : {},
      note: i === 0 ? "공유 검토 메모" : "",
      original_body: "DO NOT EXPORT ORIGINAL BODY",
      private_note: "DO NOT EXPORT PRIVATE NOTE",
    })),
    topics: [
      {
        section: "introduction",
        title: "기존 연구 배경",
        body: "질환의 근거를 정리한다.\n반복 인용도 유지한다.",
        reference_ids: [101, 102, 101],
      },
      {
        section: "discussion",
        title: "해석과 한계",
        body: "효과의 차이는 추가 검토가 필요하다.",
        reference_ids: [101],
      },
    ],
  };
}

const decodeXml = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
async function parts(input, options) {
  const zip = await JSZip.loadAsync(await createResearchDocxBytes(input, options));
  return {
    zip,
    xml: await zip.file("word/document.xml").async("string"),
    rels: await zip.file("word/_rels/document.xml.rels").async("string"),
    styles: await zip.file("word/styles.xml").async("string"),
  };
}

describe("research project exports", () => {
  it("adapts every project reference and preserves explicit empty manual overrides", () => {
    const model = adaptResearchWorkspaceExport(snapshot(23));
    expect(model.papers).toHaveLength(23);
    expect(model.rows).toHaveLength(23);
    expect(model.rows[0].cells.outcome).toEqual({
      value: "사용자 결과",
      origin: "사용자 입력",
      sourceIds: ["101"],
    });
    expect(model.rows[0].cells.limitations.value).toBe("");
    expect(model.rows[0].cells.limitations.origin).toBe("사용자 입력");
    expect(model.sections[0].topics[0].paragraphs[0].sourceIds).toEqual(["101", "102"]);
    expect(model.sharedNotes[0].body).toBe("공유 검토 메모");
    expect(JSON.stringify(model)).not.toContain("DO NOT EXPORT");
  });

  it("does not label never-processed cells as automatically extracted", () => {
    const input = snapshot(2);
    delete input.references[1].auto_values.design;
    const model = adaptResearchWorkspaceExport(input);
    expect(model.rows[1].cells.design).toMatchObject({ value: "", origin: "" });
    expect(model.rows[0].cells.limitations).toMatchObject({ value: "", origin: "사용자 입력" });
  });

  it("exports topic-linked cell labels and effective values with their exact reference", async () => {
    const input = snapshot(2);
    input.topics[0].cell_links = [
      { reference_id: 101, column_id: "outcome" },
      { reference_id: 101, column_id: "limitations" },
      { reference_id: 102, column_id: "design" },
    ];
    const model = adaptResearchWorkspaceExport(input);
    const paragraphs = model.sections[0].topics[0].paragraphs;
    expect(paragraphs[0].text).toBe(input.topics[0].body);
    expect(paragraphs[1]).toEqual({
      text: "연결한 연구표 셀 결과: 사용자 결과 (사용자 입력)",
      sourceIds: ["101"],
    });
    expect(paragraphs[2]).toEqual({
      text: "연결한 연구표 셀 한계: 미입력 (사용자 입력)",
      sourceIds: ["101"],
    });
    expect(paragraphs[3]).toEqual({
      text: "연결한 연구표 셀 연구 설계: 무작위 시험 (자동 추출)",
      sourceIds: ["102"],
    });
    expect(buildResearchCsv(input)).toContain(paragraphs[1].text);
    const { xml } = await parts(input);
    expect(xml).toContain(paragraphs[1].text);
    expect(xml).toContain(paragraphs[2].text);
  });

  it("fails on missing citation metadata instead of silently dropping sources", () => {
    const input = snapshot();
    input.topics[0].reference_ids = [999];
    expect(() => adaptResearchWorkspaceExport(input)).toThrow(/서지 정보가 없습니다/);
  });

  it("rejects duplicate project identifiers", () => {
    const input = snapshot();
    input.references[1].id = input.references[0].id;
    expect(() => normalizeResearchExport(input)).toThrow(/중복/);
  });

  it("exports full table, source mapping, intro/discussion and shared notes to safe CSV", () => {
    const input = snapshot(23);
    input.topics[1].body = '=HYPERLINK("bad")';
    const value = buildResearchCsv(input);
    expect(value.startsWith("\uFEFF")).toBe(true);
    expect(value.match(/"연구표"/g)).toHaveLength(23);
    expect(value).toContain('한글 연구 23 <치료> & ""비교""');
    expect(value).toContain("서론 자료");
    expect(value).toContain("고찰 자료");
    expect(value).toContain('"\'=HYPERLINK(""bad"")"');
    expect(value).toContain("사용자 결과");
    expect(value).toContain("공유 검토 메모");
    expect(value).toContain("PMID 42200001");
    expect(value).not.toContain("DO NOT EXPORT");
  });

  it("escapes spreadsheet formulas after whitespace and preserves multiline text", () => {
    const input = snapshot(2);
    input.references[0].user_values.design = "  +SUM(1,2)";
    expect(buildResearchCsv(input)).toContain('"\'  +SUM(1,2)"');
    expect(buildResearchCsv(input)).toContain("질환의 근거를 정리한다.\n반복 인용도 유지한다.");
  });

  it("exports RIS metadata without invented PMID DOI or source links", () => {
    const input = snapshot(2);
    input.topics = [];
    input.references[1].bibliography = { title: "Manual\nER  -\nTY  - Evil", authors: [], journal: "기타" };
    const value = buildResearchRis(input);
    expect(value.match(/^TY  - JOUR$/gm)).toHaveLength(2);
    expect(value.match(/^ER  -$/gm)).toHaveLength(2);
    const missing = value.split("\r\n\r\n")[1];
    expect(missing).not.toMatch(/^(DO|AN|UR)  - /m);
    expect(missing).not.toContain("undefined");
    expect(missing).toContain("TI  - Manual ER  - TY  - Evil");
  });

  it("includes private notes only with explicit opt-in across normal exports", async () => {
    const model = adaptResearchWorkspaceExport(snapshot(2));
    const input = { ...model, privateNotes: [{ body: "PRIVATE OPT IN", sourceIds: ["101"] }] };
    expect(buildResearchCsv(input)).not.toContain("PRIVATE OPT IN");
    expect((await parts(input)).xml).not.toContain("PRIVATE OPT IN");
    expect(buildResearchCsv({ ...input, includePrivateNotes: true })).toContain("PRIVATE OPT IN");
    expect((await parts({ ...input, includePrivateNotes: true })).xml).toContain("PRIVATE OPT IN");
  });

  it("creates real editable DOCX tables, headings, Korean text and safe links for all rows", async () => {
    const { xml, rels, styles, zip } = await parts(snapshot(7));
    expect(zip.file("[Content_Types].xml")).toBeTruthy();
    expect(xml).toContain("한글 연구 7 &lt;치료&gt; &amp; &quot;비교&quot;");
    expect(xml).toContain('w:pStyle w:val="Title"');
    expect(xml).toContain('w:pStyle w:val="Heading1"');
    expect(xml).toContain("서론 자료");
    expect(xml).toContain("고찰 자료");
    expect(xml.match(/<w:tbl>/g)).toHaveLength(2);
    expect(xml.match(/<w:tblHeader\/>/g)).toHaveLength(2);
    expect(xml).not.toContain("w:documentProtection");
    expect(xml).not.toContain("DO NOT EXPORT");
    expect(xml).not.toContain("ZOTERO_TRANSFER_DOCUMENT");
    expect(styles).toContain('w:eastAsia="Malgun Gothic"');
    expect(rels).toContain("https://pubmed.ncbi.nlm.nih.gov/42200007/");
    expect(xml).toContain('w:orient="landscape"');
  });

  it("uses official transfer structure with embedded items and stable repeated source identities", async () => {
    const { xml, rels } = await parts(snapshot(7), { zoteroTransfer: true });
    const allText = [...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1]));
    expect(allText[0]).toBe("ZOTERO_TRANSFER_DOCUMENT");
    const codes = allText.filter((value) => value.startsWith("ITEM CSL_CITATION "));
    expect(codes.length).toBeGreaterThan(7);
    const parsed = codes.map((value) => JSON.parse(value.slice("ITEM CSL_CITATION ".length)));
    expect(new Set(parsed.map((c) => c.citationID)).size).toBe(parsed.length);
    const repeated = parsed.flatMap((c) => c.citationItems).filter((c) => c.itemData.PMID === "42200001");
    expect(repeated.length).toBeGreaterThan(2);
    expect(new Set(repeated.map((c) => c.id)).size).toBe(1);
    expect(new Set(repeated.map((c) => c.uris[0])).size).toBe(1);
    expect(repeated[0].itemData.title).toBe('한글 연구 1 <치료> & "비교"');
    expect(rels).toContain('Target="https://www.zotero.org/"');
    expect(allText.some((value) => value.startsWith('BIBL {"uncited":[]'))).toBe(true);
    expect(allText.at(-1)).toMatch(/^DOCUMENT_PREFERENCES <data data-version="3">/);
    expect(allText.at(-1)).toContain('name="fieldType" value="Field"');
    expect(xml).not.toMatch(/zotero\.org\/(?:users|groups)\//);
  });

  it("keeps identifier-less embedded citations stable without fabricating a Zotero account", () => {
    const p = { id: "manual-17", title: "서지 정보만 있는 논문", journal: "학술지" };
    const code = JSON.parse(zoteroCitationCode([p], "citation-1", [1]).slice(18));
    expect(code.citationItems[0].uris).toEqual(["urn:uro-daily-pick:reference:manual-17"]);
    expect(code.citationItems[0].itemData).toEqual(researchCslItem(p));
    expect(code.citationItems[0].itemData).not.toHaveProperty("DOI");
    expect(code.citationItems[0].itemData).not.toHaveProperty("PMID");
  });

  it("escapes document preferences independently of OOXML escaping", () => {
    expect(zoteroDocumentData('a"<&')).toContain('id="a&quot;&lt;&amp;"');
  });

  it("keeps unvalidated transfer export out of released capabilities", () => {
    expect(getResearchExportCapabilities()).toMatchObject({ docx: true, csv: true, ris: true });
    expect(typeof getResearchExportCapabilities().zoteroTransfer).toBe("boolean");
  });
});
