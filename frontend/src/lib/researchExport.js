/** Browser-only research exports. Inputs contain metadata and derived/user-authored text, never originals. */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const ZOTERO_TRANSFER_HELP =
  "Word에서 문서를 연 뒤 Zotero 탭의 Refresh를 실행하세요. 인용은 문서에 포함된 서지 데이터로 관리되며, 내 Zotero 라이브러리 항목과 자동 연결되지는 않습니다.";
// Enable only after a real Zotero importer successfully refreshes the generated fixture.
export const getResearchExportCapabilities = () => ({
  docx: true,
  csv: true,
  ris: true,
  zoteroTransfer: false,
});

const text = (value) => String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const singleLine = (value) =>
  text(value)
    .replace(/[\r\n]+/g, " ")
    .trim();
const list = (value) => (Array.isArray(value) ? value : []);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const xml = (value) =>
  text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const idOf = (p, index) => singleLine(p.referenceId ?? p.id ?? p.pmid ?? p.doi ?? `entry-${index + 1}`);
const doiOf = (value) =>
  singleLine(value)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
const validPmid = (value) => (/^[1-9]\d{0,11}$/.test(singleLine(value)) ? singleLine(value) : "");

function metadata(p, index) {
  const source = p.bibliography || p;
  return {
    id: idOf(p, index),
    paperId: p.paperId ?? p.paper_id ?? source.paper_id ?? source.id ?? null,
    pmid: validPmid(source.pmid),
    doi: doiOf(source.doi),
    title: singleLine(source.title) || "제목 미입력",
    authors: list(source.authors)
      .map((a) =>
        typeof a === "object"
          ? singleLine(a.literal || [a.family, a.given].filter(Boolean).join(", "))
          : singleLine(a),
      )
      .filter(Boolean),
    journal: singleLine(source.journal),
    pub_date: singleLine(source.pub_date),
    volume: singleLine(source.volume),
    issue: singleLine(source.issue),
    pages: singleLine(source.pages),
  };
}

export function sourceUrl(p) {
  if (p.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(p.pmid)}/`;
  if (p.doi) return `https://doi.org/${encodeURIComponent(p.doi)}`;
  return "";
}

/** Accepts the complete project snapshot returned by the research workspace RPCs. */
export function adaptResearchWorkspaceExport({
  project,
  workspace = {},
  references = [],
  topics = [],
  ...options
}) {
  const columns = list(workspace.columns).map((column) => ({
    id: text(column.id),
    label: text(column.label),
  }));
  const byReference = new Map(references.map((ref) => [String(ref.id), ref]));
  const effectiveCell = (ref, columnId) => {
    const manual = own(ref.user_values, columnId);
    const automatic = own(ref.auto_values, columnId);
    return {
      value: text(manual ? ref.user_values[columnId] : ref.auto_values?.[columnId]),
      origin: manual ? "사용자 입력" : automatic ? "자동 추출" : "",
      sourceIds: [text(ref.id)],
    };
  };
  return normalizeResearchExport({
    ...options,
    project: { ...project, question: workspace.question },
    papers: references.map(metadata),
    columns,
    rows: references.map((ref) => ({
      paperId: text(ref.id),
      cells: Object.fromEntries(columns.map((column) => [column.id, effectiveCell(ref, column.id)])),
    })),
    sections: ["introduction", "discussion"].map((section) => ({
      heading: section === "introduction" ? "서론 자료" : "고찰 자료",
      topics: topics
        .filter((topic) => topic.section === section)
        .map((topic) => ({
          heading: text(topic.title),
          paragraphs: [
            { text: text(topic.body), sourceIds: list(topic.reference_ids).map(String) },
            ...list(topic.cell_links).map((link) => {
              const ref = byReference.get(String(link.reference_id));
              if (!ref)
                throw new Error(
                  "연결한 연구표 셀의 서지 정보가 없습니다. 프로젝트 전체 자료를 다시 불러와 주세요.",
                );
              const column = columns.find((candidate) => candidate.id === link.column_id);
              const cell = effectiveCell(ref, link.column_id);
              const label = column?.label || `현재 연구표에서 삭제된 열 ${text(link.column_id)}`;
              return {
                text: `연결한 연구표 셀 ${label}: ${cell.value || "미입력"}${cell.origin ? ` (${cell.origin})` : ""}`,
                sourceIds: cell.sourceIds,
              };
            }),
          ],
        })),
    })),
    sharedNotes: references
      .filter((ref) => text(ref.note).trim())
      .map((ref) => ({ body: ref.note, sourceIds: [String(ref.id)] })),
  });
}

/** Explicit schema whitelist keeps original bodies, account identities and private notes out by default. */
export function normalizeResearchExport(input = {}) {
  if (input.references) return adaptResearchWorkspaceExport(input);
  const papers = list(input.papers).map(metadata);
  const ids = new Set();
  for (const p of papers) {
    if (ids.has(p.id)) throw new Error("내보낼 자료의 식별자가 중복됩니다.");
    ids.add(p.id);
  }
  const aliases = new Map();
  papers.forEach((p) => {
    aliases.set(p.id, p.id);
  });
  papers.forEach((p) => {
    if (p.pmid && !aliases.has(p.pmid)) aliases.set(p.pmid, p.id);
  });
  papers.forEach((p) => {
    if (p.paperId != null && !aliases.has(String(p.paperId))) aliases.set(String(p.paperId), p.id);
  });
  const sourceIds = (values) => [
    ...new Set(
      list(values).map((value) => {
        const key = aliases.get(String(value));
        if (!key)
          throw new Error(
            `출처 ${text(value)}의 서지 정보가 없습니다. 프로젝트 전체 자료를 다시 불러와 주세요.`,
          );
        return key;
      }),
    ),
  ];
  const paragraph = (p) =>
    typeof p === "string"
      ? { text: text(p), sourceIds: [] }
      : { text: text(p.text ?? p.body), sourceIds: sourceIds(p.sourceIds) };
  const columns = list(input.columns).map((column) => ({
    id: text(column.id),
    label: text(column.label || column.id),
  }));
  const rawRows = new Map(list(input.rows).map((row) => [String(row.paperId ?? row.id), row]));
  const rows = papers.map((paper) => {
    const row = rawRows.get(paper.id) || rawRows.get(paper.pmid) || {};
    return {
      paperId: paper.id,
      cells: Object.fromEntries(
        columns.map((column) => {
          const value = row.cells?.[column.id];
          const cell = value !== null && typeof value === "object" ? value : { value };
          return [
            column.id,
            {
              value: text(cell.value),
              origin: text(cell.origin || cell.source),
              sourceIds: sourceIds(cell.sourceIds || [paper.id]),
            },
          ];
        }),
      ),
    };
  });
  const note = (n) => ({
    body: text(n.body ?? n.note),
    sourceIds: sourceIds(n.sourceIds || (n.paper_id != null ? [n.paper_id] : [])),
  });
  return {
    project: {
      id: input.project?.id ?? null,
      name: text(input.project?.name || "연구 프로젝트"),
      description: text(input.project?.description),
      question: text(input.project?.question),
    },
    papers,
    columns,
    rows,
    sections: list(input.sections).map((s) => ({
      heading: text(s.heading),
      paragraphs: list(s.paragraphs).map(paragraph),
      topics: list(s.topics).map((topic) => ({
        heading: text(topic.heading),
        paragraphs: list(topic.paragraphs).map(paragraph),
      })),
    })),
    sharedNotes: list(input.sharedNotes).map(note),
    includePrivateNotes: input.includePrivateNotes === true,
    privateNotes: input.includePrivateNotes === true ? list(input.privateNotes).map(note) : [],
  };
}

function csvCell(value) {
  return (
    '"' +
    text(value)
      .replace(/^(\s*[=+@-]|[\t\r])/, "'$1")
      .replace(/"/g, '""') +
    '"'
  );
}

export function buildResearchCsv(input) {
  const model = normalizeResearchExport(input);
  const sourceText = (ids) =>
    ids
      .map((id) => {
        const p = model.papers.find((paper) => paper.id === id);
        return `${p.title}${p.pmid ? ` | PMID ${p.pmid}` : ""}${p.doi ? ` | DOI ${p.doi}` : ""}`;
      })
      .join("; ");
  const rows = [
    [
      "구분",
      "자료 ID",
      "제목 또는 주제",
      "PMID",
      "DOI",
      "저자",
      "학술지",
      "발행일",
      ...model.columns.flatMap((c) => [c.label, `${c.label} 입력 구분`, `${c.label} 출처`]),
      "내용",
      "출처",
    ],
  ];
  const row = (values) => rows.push(Array.from({ length: rows[0].length }, (_, i) => values[i] ?? ""));
  const contentAt = rows[0].length - 2;
  const narrative = (kind, title, body, ids = []) => {
    const value = [kind, "", title];
    value[contentAt] = body;
    value[contentAt + 1] = sourceText(ids);
    row(value);
  };
  narrative("연구 질문", model.project.name, model.project.question);
  if (model.project.description) narrative("프로젝트 설명", model.project.name, model.project.description);
  model.papers.forEach((p, i) =>
    row([
      "연구표",
      p.id,
      p.title,
      p.pmid,
      p.doi,
      p.authors.join("; "),
      p.journal,
      p.pub_date,
      ...model.columns.flatMap((column) => {
        const cell = model.rows[i].cells[column.id];
        return [cell.value, cell.origin, sourceText(cell.sourceIds)];
      }),
      "",
      sourceUrl(p),
    ]),
  );
  model.sections.forEach((s) => {
    s.paragraphs.forEach((p) => narrative(s.heading, s.heading, p.text, p.sourceIds));
    s.topics.forEach((t) =>
      t.paragraphs.forEach((p) => narrative(s.heading, t.heading, p.text, p.sourceIds)),
    );
  });
  model.sharedNotes.forEach((n) => narrative("공유 메모", "", n.body, n.sourceIds));
  model.privateNotes.forEach((n) => narrative("개인 메모", "", n.body, n.sourceIds));
  return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function buildResearchRis(input) {
  return normalizeResearchExport(input)
    .papers.map((p) =>
      [
        "TY  - JOUR",
        `ID  - ${singleLine(p.id)}`,
        `TI  - ${p.title}`,
        ...p.authors.map((a) => `AU  - ${a}`),
        p.journal && `JO  - ${p.journal}`,
        /^\d{4}/.test(p.pub_date) && `PY  - ${p.pub_date.slice(0, 4)}`,
        p.pub_date && `DA  - ${p.pub_date}`,
        p.volume && `VL  - ${p.volume}`,
        p.issue && `IS  - ${p.issue}`,
        p.pages && `SP  - ${p.pages}`,
        p.doi && `DO  - ${p.doi}`,
        p.pmid && `AN  - ${p.pmid}`,
        sourceUrl(p) && `UR  - ${sourceUrl(p)}`,
        "ER  -",
      ]
        .filter(Boolean)
        .join("\r\n"),
    )
    .join("\r\n\r\n");
}

export function researchCslItem(paper) {
  const p = metadata(paper, 0);
  const date = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(p.pub_date);
  return {
    id: `uro-reference/${p.id}`,
    type: "article-journal",
    title: p.title,
    ...(p.authors.length ? { author: p.authors.map((a) => ({ literal: a })) } : {}),
    ...(p.journal ? { "container-title": p.journal } : {}),
    ...(date ? { issued: { "date-parts": [date.slice(1).filter(Boolean).map(Number)] } } : {}),
    ...(p.doi ? { DOI: p.doi } : {}),
    ...(p.pmid ? { PMID: p.pmid } : {}),
    ...(p.volume ? { volume: p.volume } : {}),
    ...(p.issue ? { issue: p.issue } : {}),
    ...(p.pages ? { page: p.pages } : {}),
    ...(sourceUrl(p) ? { URL: sourceUrl(p) } : {}),
  };
}

// Official protocol: https://www.zotero.org/support/dev/client_coding/libreoffice_plugin_wire_protocol#document_exportdocument
// Windows import/export prefixes: https://github.com/zotero/zotero-word-for-windows-integration/blob/main/build/zoteroWinWordIntegration/document.cpp
// Embedded metadata/URI identity: Zotero Integration.Citation.loadItemData and Integration.URIMap.
// These are document citations. No user's Zotero item key, library URI or library import is asserted.
export function zoteroCitationCode(papers, citationID, numbers = []) {
  const plainCitation = `[${numbers.join(", ")}]`;
  return (
    "ITEM CSL_CITATION " +
    JSON.stringify({
      citationID,
      properties: { formattedCitation: plainCitation, plainCitation, noteIndex: 0 },
      citationItems: papers.map((p) => ({
        id: researchCslItem(p).id,
        uris: [sourceUrl(p) || `urn:uro-daily-pick:reference:${encodeURIComponent(p.id)}`],
        itemData: researchCslItem(p),
      })),
      schema: "https://github.com/citation-style-language/schema/raw/master/csl-citation.json",
    })
  );
}

export function zoteroDocumentData(sessionID) {
  return `<data data-version="3"><session id="${xml(sessionID)}"/><style id="http://www.zotero.org/styles/vancouver" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="0"/><prefs><pref name="fieldType" value="Field"/><pref name="noteType" value="0"/><pref name="automaticJournalAbbreviations" value="false"/></prefs></data>`;
}

/** Builds editable OOXML; normal exports have ordinary numbered source links, transfer exports have official transport links. */
export async function buildResearchDocument(input, { zoteroTransfer = false } = {}) {
  const model = normalizeResearchExport(input);
  const {
    Document,
    Paragraph,
    TextRun,
    ExternalHyperlink,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    HeadingLevel,
    VerticalAlign,
    PageOrientation,
    TableLayoutType,
  } = await import("docx");
  const byId = new Map(model.papers.map((p, index) => [p.id, { ...p, number: index + 1 }]));
  let citationIndex = 0;
  const session =
    globalThis.crypto?.randomUUID?.() || `uro-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const run = (value, props = {}) => new TextRun({ text: text(value), ...props });
  const link = (value, url) =>
    new ExternalHyperlink({ link: url, children: [run(value, { style: "Hyperlink" })] });
  const citation = (ids) => {
    const sources = ids.map((id) => byId.get(id));
    if (!sources.length) return [];
    if (zoteroTransfer)
      return [
        run(" "),
        link(
          zoteroCitationCode(
            sources,
            `${session}-${++citationIndex}`,
            sources.map((p) => p.number),
          ),
          "https://www.zotero.org/",
        ),
      ];
    return sources.flatMap((p) => [
      run(" "),
      sourceUrl(p) ? link(`[${p.number}]`, sourceUrl(p)) : run(`[${p.number}]`),
    ]);
  };
  const para = (value, ids = [], props = {}) =>
    new Paragraph({ ...props, children: [run(value), ...citation(ids)] });
  const heading = (value, level = HeadingLevel.HEADING_1) => para(value, [], { heading: level });
  const paragraphs = (value, ids = []) =>
    text(value)
      .split(/\r?\n/)
      .map((line, index, all) => para(line, index === all.length - 1 ? ids : []));
  const children = [];
  if (zoteroTransfer)
    children.push(para("ZOTERO_TRANSFER_DOCUMENT"), para(""), para(ZOTERO_TRANSFER_HELP), para(""));
  children.push(heading(`${model.project.name} 연구 자료`, HeadingLevel.TITLE));
  children.push(para(`프로젝트 전체 자료 ${model.papers.length}편의 연구표와 집필 자료입니다.`));
  if (model.project.description) children.push(...paragraphs(model.project.description));
  if (model.project.question) children.push(heading("연구 질문"), ...paragraphs(model.project.question));

  const border = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" };
  const borders = {
    top: border,
    bottom: border,
    left: border,
    right: border,
    insideHorizontal: border,
    insideVertical: border,
  };
  const totalWidth = 14390;
  const cell = (content, width, header = false) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 110, bottom: 110, left: 140, right: 140 },
      shading: header ? { fill: "DCEAF5" } : { fill: "FFFFFF" },
      borders,
      children: content,
    });
  children.push(heading("연구표"));
  // Column bands preserve every reference and every extraction column at readable widths.
  const bands = model.columns.length
    ? Array.from({ length: Math.ceil(model.columns.length / 3) }, (_, i) =>
        model.columns.slice(i * 3, i * 3 + 3),
      )
    : [[]];
  bands.forEach((band, index) => {
    if (bands.length > 1) children.push(heading(`연구표 ${index + 1}`, HeadingLevel.HEADING_2));
    const sourceWidth = band.length ? 3650 : totalWidth;
    const valueWidth = band.length ? Math.floor((totalWidth - sourceWidth) / band.length) : 0;
    children.push(
      new Table({
        width: { size: totalWidth, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        columnWidths: [sourceWidth, ...band.map(() => valueWidth)],
        borders,
        rows: [
          new TableRow({
            tableHeader: true,
            children: [
              cell([para("논문과 출처")], sourceWidth, true),
              ...band.map((c) => cell([para(c.label)], valueWidth, true)),
            ],
          }),
          ...model.papers.map(
            (p, paperIndex) =>
              new TableRow({
                children: [
                  cell(
                    [
                      para(p.title, [p.id]),
                      para([p.authors.join(", "), p.journal, p.pub_date].filter(Boolean).join(" · ")),
                      ...(p.pmid ? [para(`PMID ${p.pmid}`)] : []),
                      ...(p.doi ? [para(`DOI ${p.doi}`)] : []),
                    ],
                    sourceWidth,
                  ),
                  ...band.map((c) => {
                    const value = model.rows[paperIndex].cells[c.id];
                    return cell(
                      [
                        ...paragraphs(value.value || "미입력"),
                        ...(value.origin ? [para(value.origin, [], { style: "Provenance" })] : []),
                        ...(value.sourceIds.some((id) => id !== p.id) ? [para("출처", value.sourceIds)] : []),
                      ],
                      valueWidth,
                    );
                  }),
                ],
              }),
          ),
        ],
      }),
    );
    children.push(para(""));
  });
  model.sections.forEach((section) => {
    children.push(heading(section.heading));
    section.paragraphs.forEach((p) => children.push(...paragraphs(p.text, p.sourceIds)));
    section.topics.forEach((topic) => {
      children.push(heading(topic.heading, HeadingLevel.HEADING_2));
      topic.paragraphs.forEach((p) => children.push(...paragraphs(p.text, p.sourceIds)));
    });
    if (!section.paragraphs.length && !section.topics.length) children.push(para("등록된 자료가 없습니다."));
  });
  [
    ["공유 메모", model.sharedNotes],
    ["개인 메모", model.privateNotes],
  ].forEach(([title, notes]) => {
    if (!notes.length) return;
    children.push(heading(title));
    notes.forEach((n) => children.push(...paragraphs(n.body, n.sourceIds)));
  });
  children.push(heading("참고문헌"));
  if (zoteroTransfer && model.papers.length) {
    children.push(
      new Paragraph({
        children: [
          link('BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY', "https://www.zotero.org/"),
        ],
      }),
    );
  } else
    model.papers.forEach((p, i) =>
      children.push(
        para(
          `[${i + 1}] ${[p.authors.join(", "), p.title, p.journal, p.pub_date, [p.volume, p.issue && `(${p.issue})`, p.pages && `:${p.pages}`].filter(Boolean).join("")].filter(Boolean).join(". ")}.`,
          [p.id],
        ),
      ),
    );
  if (zoteroTransfer)
    children.push(
      new Paragraph({
        children: [link("DOCUMENT_PREFERENCES " + zoteroDocumentData(session), "https://www.zotero.org/")],
      }),
    );
  const black = { color: "000000", font: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Malgun Gothic" } };
  return new Document({
    creator: "Uro Daily Pick",
    title: `${model.project.name} 연구 자료`,
    description: "프로젝트 연구표와 서론 고찰 자료",
    styles: {
      default: {
        document: { run: { ...black, size: 21 }, paragraph: { spacing: { after: 100, line: 276 } } },
        title: { run: { ...black, size: 36, bold: true }, paragraph: { spacing: { after: 220 } } },
        heading1: {
          run: { ...black, size: 28, bold: true },
          paragraph: { spacing: { before: 240, after: 160 }, keepNext: true },
        },
        heading2: {
          run: { ...black, size: 23, bold: true },
          paragraph: { spacing: { before: 180, after: 120 }, keepNext: true },
        },
      },
      paragraphStyles: [
        {
          id: "Provenance",
          name: "출처 구분",
          basedOn: "Normal",
          run: { color: "555555", size: 17 },
          paragraph: { spacing: { before: 90, after: 0 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE, width: 11906, height: 16838 },
            margin: { top: 1050, bottom: 1050, left: 1224, right: 1224 },
          },
        },
        children,
      },
    ],
  });
}

export async function createResearchDocxBytes(input, options) {
  const { Packer } = await import("docx");
  return new Uint8Array(await Packer.toArrayBuffer(await buildResearchDocument(input, options)));
}

export async function createResearchDocx(input, options) {
  return new Blob([await createResearchDocxBytes(input, options)], { type: DOCX_MIME });
}

export const createZoteroTransferDocx = (input) => createResearchDocx(input, { zoteroTransfer: true });

export function downloadResearchExport(filename, contents, mime = "text/plain;charset=utf-8") {
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
