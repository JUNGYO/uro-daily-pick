import { Link } from "react-router-dom";
import { rpc } from "../lib/workspace";
import { ReaderPage, Resource, useResource } from "../components/ReaderUI";
export default function Preview() {
  const r = useResource(() => rpc("preview_papers"), []);
  return (
    <ReaderPage title="Uro Daily Pick" description="비뇨의학 문헌의 본문 기반 요약을 확인하세요.">
      <div className="reader-actions">
        <Link className="btn-primary" to="/login">
          계정으로 로그인
        </Link>
        <Link to="/welcome">서비스 소개</Link>
      </div>
      <Resource resource={r}>
        {r.data?.length ? (
          r.data.map((p) => (
            <article className="reader-card" key={p.pmid}>
              <p className="reader-muted">
                {p.journal} · {p.pub_date}
              </p>
              <h2>{p.title}</h2>
              <section className="reader-summary">
                <h3>본문 기반 세 줄 요약</h3>
                <ol>
                  {p.summary_ko.split("\n").map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ol>
              </section>
              <a
                className="text-accent underline"
                href={"https://pubmed.ncbi.nlm.nih.gov/" + p.pmid + "/"}
                target="_blank"
                rel="noreferrer"
              >
                PubMed에서 문헌 확인
              </a>
            </article>
          ))
        ) : (
          <p>지금 공개할 요약이 없습니다. 잠시 후 다시 확인해 주세요.</p>
        )}
      </Resource>
      <p className="reader-muted">
        AI 요약은 원문의 대상·결과·한계와 함께 검토하세요. 원문 접근은 이용자와 소속 기관의 권한에 따릅니다.
      </p>
      <Link to="/privacy">개인정보·연구 이용 안내</Link>
    </ReaderPage>
  );
}
