import { Link } from "react-router-dom";
import { rpc } from "../lib/workspace";
import { useResource, Resource } from "./ReaderUI";
export default function ProjectProgress({ project }) {
  const state = useResource(() => rpc("review_workspace", { p_project: project.id }), [project.id]);
  return (
    <Resource resource={state}>
      {state.data && (
        <section className="project-progress" aria-label="프로젝트 진행 상태">
          <Link to={`/projects?project=${project.id}&view=review&stage=protocol`}>
            <span>연구계획</span>
            <strong>{state.data.protocol ? `버전 ${state.data.protocol.version}` : "작성 시작"}</strong>
          </Link>
          <Link to={`/projects?project=${project.id}&view=review&stage=reports`}>
            <span>선별 대기</span>
            <strong>{(state.data.counts.ta_pending || 0) + (state.data.counts.ft_pending || 0)}편</strong>
          </Link>
          <Link to={`/projects?project=${project.id}&view=review&stage=reports`}>
            <span>포함 문헌</span>
            <strong>{state.data.counts.included || 0}편</strong>
          </Link>
          <Link to={`/projects?project=${project.id}&view=review&stage=observations`}>
            <span>원문 대조한 수치</span>
            <strong>{state.data.counts.confirmed || 0}건</strong>
          </Link>
        </section>
      )}
    </Resource>
  );
}
