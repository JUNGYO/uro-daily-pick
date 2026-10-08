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
let liveAtlasCalls = 0;
export function knowledgeRpc(name, args, scenario, papers) {
  if (scenario === "knowledge-error")
    return { error: { message: "Simulated knowledge outage" } };
  if (name === "knowledge_network") {
    const f=args.p_filters;
    const old=knowledgeRpc('knowledge_atlas',{p_query:f.q,p_from:f.from,p_to:f.to,p_journal:f.journal,p_design:f.design,p_relation:f.relation},scenario,papers).data;
    const mapped=old.nodes.map(n=>({...n,kind:n.kind==='paper'?'paper':n.kind==='condition'?'condition':'unclassified',resolution:n.kind==='condition'?'exact':'unmapped',concept_ui:n.kind==='condition'?'M0017834':null,vocabulary_year:'2026',source_labels:[n.label],concept_ids:[n.id]}));
    const selection=mapped.find(n=>n.id===f.focus),peer=mapped.find(n=>n.id===f.peer);
    return {data:{...old,nodes:mapped,filters:f,focus:f.focus,peer:f.peer,selection,selection_peer:peer,
      selected_documents:f.peer?12:old.matched_documents,
      edges:old.edges.filter(e=>e.weight>=f.min_shared),updated_at:'2026-10-08T01:00:00Z',
      coverage:{concepts:old.nodes.length,resolved:1,node_limit:f.limit,edge_limit:500,minimum_shared:f.min_shared,links_at_threshold:old.edges.length,single_paper_pairs:0,metadata_papers:12,papers_with_reference_ids:5,reference_identifiers:30},
      notes:selection&&!f.peer?[{concept_id:selection.id,label:selection.label,wiki:knowledgeRpc('knowledge_page',{p_id:selection.id},scenario,papers).data.wiki}]:[]},error:null};
  }
  if (name === "knowledge_atlas") {
    const liveCount = scenario === 'atlas-live' ? 30 + liveAtlasCalls++ : 30;
    const graphNodes = scenario === "atlas-dense" ? [...nodes,...Array.from({length:21},(_,i)=>({id:(i+10).toString(16).padStart(24,'0'),label:['robot-assisted radical prostatectomy','urinary continence recovery','biochemical recurrence-free survival','fluorescence confocal microscopy'][i%4]+` ${i+1}`,kind:['condition','intervention','outcome','test'][i%4],document_count:10-i%5}))] : nodes;
    const empty = scenario === "knowledge-empty" || args.p_query === "no-such-concept";
    const filtered = args.p_from === 2024 || args.p_journal || args.p_design;
    const selectedPapers = empty ? [] : papers.slice(0, filtered ? 1 : 3).map(p=>({...p,structured:true}));
    return {data:{nodes:empty?[]:args.p_relation === 'citations' ? selectedPapers.map(p=>({id:p.pmid,label:p.title,kind:'paper',document_count:1,year:2024})) : graphNodes,
      edges:empty?[]:args.p_relation === 'citations' ? [{source:papers[0].pmid,target:papers[1].pmid,weight:1}] : [{source:nodes[0].id,target:nodes[1].id,weight:12},{source:nodes[0].id,target:nodes[2].id,weight:8}],
      relationship:args.p_relation||'concepts',matched_documents:empty?0:filtered?1:liveCount,indexed_documents:empty?0:liveCount,structured_documents:empty?0:filtered?1:12,
      years:empty?[]:filtered?[{year:2024,papers:1,structured:1}]:[{year:2001,papers:3,structured:1},{year:2020,papers:7,structured:2},{year:2024,papers:12,structured:5},{year:2026,papers:8,structured:4}],
      journals:[{label:'European urology',papers:18},{label:'BJU international',papers:12}],designs:[{label:'RCT',papers:5},{label:'Retrospective',papers:25}],papers:selectedPapers,groups:[]},error:null};
  }
  if (name === "knowledge_paper") {
    const p = papers.find(p=>p.pmid===args.p_pmid)||papers[0];
    return {data:{...p,content_hash:'a'.repeat(64),related_reports:[{pmid:papers[1].pmid,title:papers[1].title,registry_id:'NCT12345678',source_relation:'registered',target_relation:'mentioned'}],science:{
      facts:[{id:'sample',field:'sample_size',value:'195 men',locations:['p-0000000']},{id:'design',field:'design',value:'retrospective cohort study',locations:['p-0000000']}],
      results:[{id:'result',measure:'HR',estimate:'0.70',ci_low:'0.50',ci_high:'0.90',ci_level:'95',outcome:'recurrence',population:'195 men',comparison:null,timepoint:'12 months',unit:null,adjustment:'adjusted',locations:['p-0000000']}],
      terminology:[{concept_id:nodes[0].id,system:'MeSH',id:'D011471',label:'Prostatic Neoplasms'}],
      bibliography:{source:'PubMed',fetched_at:'2026-10-08T01:00:00Z',authors:['Fixture Author'],journal:'European urology',volume:'87',issue:'2',pages:'100-109',doi:'10.1234/fixture',pmcid:null,publication_types:['Journal Article'],dates:[{kind:'journal',date:'2024',precision:'year'},{kind:'electronic',date:'2023-12-14',precision:'day'}],references:[{source_id:'r1',pmid:papers[1].pmid,doi:null}]},
      coverage:{facts_published:2,facts_total:2,results_published:1,results_total:1},provenance:{model:'Fixture model',recipe:'scientific-v1',extracted_at:'2026-10-08T01:00:00Z',chunks:3,rejected_candidates:1,review_status:'unreviewed'}
    }},error:null};
  }
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
                    text: "This is synthetic material for interface testing. Findings depend on study populations and comparisons; check each paper for context.",
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
