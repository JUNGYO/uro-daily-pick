const nodes = [
  {
    id: "a".repeat(24),
    label: "prostate cancer",
    label_ko: "전립선암",
    kind: "condition",
    aliases: [],
    document_count: 28,
    status: "ready",
  },
  {
    id: "b".repeat(24),
    label: "active surveillance",
    label_ko: "적극적 감시",
    kind: "intervention",
    aliases: [],
    document_count: 16,
    status: "ready",
  },
  {
    id: "c".repeat(24),
    label: "patient-reported quality of life after treatment",
    label_ko: "치료 후 환자 보고 삶의 질",
    kind: "outcome",
    aliases: [],
    document_count: 12,
    status: "building",
  },
];
export function knowledgeRpc(name, args, scenario, papers) {
  if (scenario === "knowledge-error")
    return { error: { message: "Simulated knowledge outage" } };
  if (name === "knowledge_search")
    return {
      data: {
        items:
          scenario === "knowledge-empty"
            ? []
            : nodes.filter(
                (n) =>
                  !args.p_query ||
                  (n.label + " " + n.label_ko).includes(args.p_query),
              ),
        indexed_documents: scenario === "knowledge-empty" ? 0 : 30,
        updated_at: "2026-10-08T01:00:00Z",
      },
      error: null,
    };
  if (name === "knowledge_graph")
    return {
      data: {
        nodes: scenario === "knowledge-empty" ? [] : nodes,
        groups: [{id: nodes[0].id, label: '전립선암', concepts: [nodes[0].id,nodes[1].id]}],
        edges: [
          { source: nodes[0].id, target: nodes[1].id, weight: 12 },
          { source: nodes[0].id, target: nodes[2].id, weight: 8 },
        ],
      },
      error: null,
    };
  if (name === "knowledge_page")
    return {
      data: {
        concept: nodes.find((n) => n.id === args.p_id) || nodes[0],
        wiki: {
          revision: "r1",
          status: scenario === "knowledge-stale" ? "updating" : scenario === "knowledge-indexed" ? "indexed" : "ready",
          updated_at: "2026-10-08T01:00:00Z",
          paragraphs:
            ["knowledge-stale", "knowledge-indexed"].includes(scenario)
              ? []
              : [
                  {
                    text: "이 문장은 화면 검증을 위한 가상 자료입니다. 연구 대상과 비교군이 서로 달라 각 논문의 조건을 확인해야 합니다.",
                    sources: [
                      {
                        pmid: papers[0].pmid,
                        content_hash: "a".repeat(64),
                        locations: ["p-0000000"],
                      },
                    ],
                  },
                ],
        },
        papers: papers.slice(0, 3),
        neighbors: nodes
          .filter((n) => n.id !== args.p_id)
          .map((n) => ({ ...n, shared_papers: 8 })),
      },
      error: null,
    };
}
