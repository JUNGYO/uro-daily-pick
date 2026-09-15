import { useSearchParams, Link } from "react-router-dom";
import { rpc, exportReferences, download, csv, paperLink } from "../lib/workspace";
import { ReaderPage, Resource, useResource } from "../components/ReaderUI";
import { FIELDS } from "./Paper";
export default function Compare() {
  const [params] = useSearchParams(),
    ids = [...new Set((params.get("pmids") || "").split(","))]
      .filter((x) => /^[1-9][0-9]{0,11}$/.test(x))
      .slice(0, 5);
  const r = useResource(async () => {
    if (ids.length < 2) throw new Error("비교할 문헌을 2~5편 선택해 주세요.");
    const rows = await Promise.all(ids.map((pmid) => rpc("reader_paper", { p_pmid: pmid })));
    return rows.filter(Boolean).map((r) => r.paper);
  }, [ids.join(",")]);
  const rows = r.data
    ? [
        ["항목", ...r.data.map((p) => p.title)],
        ...FIELDS.map(([key, label]) => [
          label,
          ...r.data.map((p) => p.research_details?.[key] || p.structured_data?.[key] || "확인 전"),
        ]),
      ]
    : [];
  return (
    <ReaderPage
      title="문헌 비교"
      description="서로 다른 대상·시점의 수치를 합산하지 않습니다. 각 결과의 근거와 한계를 함께 확인하세요."
    >
      <Link to="/discover">← 문헌 탐색</Link>
      <Resource resource={r}>
        {r.data && (
          <>
            <div className="reader-actions">
              <button
                className="btn-secondary"
                onClick={() => download("comparison.csv", csv(rows), "text/csv")}
              >
                비교 표 CSV
              </button>
              <button
                className="btn-secondary"
                onClick={() => download("references.ris", exportReferences(r.data, "ris"))}
              >
                참고문헌 RIS
              </button>
              <button
                className="btn-secondary"
                onClick={() => download("references.bib", exportReferences(r.data, "bib"))}
              >
                참고문헌 BibTeX
              </button>
            </div>
            <div className="reader-table" tabIndex={0} aria-label="논문 비교 표">
              <table>
                <thead>
                  <tr>
                    <th scope="col">항목</th>
                    {r.data.map((p) => (
                      <th scope="col" key={p.id}>
                        <Link to={paperLink(p) + "?tab=study"}>{p.title}</Link>
                        {p.integrity_status === "retracted" && <p>철회된 문헌</p>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {FIELDS.map(([key, label]) => (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      {r.data.map((p) => (
                        <td key={p.id}>
                          {p.research_details?.[key] || p.structured_data?.[key] || "확인 전"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="reader-muted">
              확인 전: 원문 추출이 아직 완료되지 않은 항목입니다. 보고되지 않음: 검토한 원문에 해당 값이
              없다는 뜻입니다.
            </p>
          </>
        )}
      </Resource>
    </ReaderPage>
  );
}
