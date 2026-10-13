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
    if(scenario==='integration-navigation') {
      const scoped=f.project||f.library||f.scope_concept;
      const context={project:f.project,project_name:f.project?'Journal club':null,library:f.library,
        scope_papers:f.project||f.library?3:null,unlinked_project_records:f.project?1:0,
        topic_label:f.scope_concept?'prostate cancer':null,topic_peer_label:f.scope_peer?'active surveillance':null};
      const mapped=nodes.map((n,i)=>({...n,document_count:i?1:2,kind:n.kind==='condition'?'condition':'unclassified',source_labels:[n.label]}));
      const selected=mapped.find(n=>n.id===f.focus);
      if(f.relation!=='citations') return {data:{...old,context,nodes:mapped,selection:selected,focus:f.focus,peer:f.peer,filters:f,notes:[],
        papers:old.papers.slice(0,scoped||f.focus?2:3),indexed_documents:3,structured_documents:1,matched_documents:scoped?2:3,selected_documents:f.focus||scoped?2:3,years:[{year:2024,papers:f.focus||scoped?2:3,structured:1}],edges:old.edges.map(e=>({...e,weight:1})),coverage:{concepts:3,node_limit:f.limit}},error:null};
      const seeds=papers.slice(0,2).map((p,i)=>({id:p.pmid,pmid:p.pmid,label:p.title,year:2024+i,authors:p.authors,journal:p.journal,in_catalog:true,indexed:true,matching_source:true,kind:'paper',incoming_citations:i?1:0,identified_references:i?0:25}));
      const targets=Array.from({length:24},(_,i)=>({id:String(910000+i),pmid:String(910000+i),label:'Identified reference '+(i+1),year:2000+i,authors:[],kind:'reference',in_catalog:false,indexed:false,matching_source:false,incoming_citations:1,identified_references:0}));
      const graph=[...seeds,...targets],edges=graph.slice(1).map(n=>({source:seeds[0].id,target:n.id,weight:1}));
      const focal=graph.find(n=>n.id===f.focus);
      const list=graph.filter(n=>n.id!==f.focus&&(!f.focus||edges.some(e=>(f.direction!=='cited-by'&&e.source===f.focus&&e.target===n.id)||(f.direction!=='references'&&e.target===f.focus&&e.source===n.id))));
      return {data:{...old,context,nodes:graph,edges,focus:f.focus,peer:f.peer,filters:f,citation_selection:focal?[focal]:[],
        citation_papers:list.slice((f.citation_page||0)*20,(f.citation_page||0)*20+20),citation_paper_count:list.length,
        papers:old.papers.slice(0,2),indexed_documents:3,structured_documents:1,matched_documents:2,selected_documents:2,years:[{year:2024,papers:2,structured:1}],notes:[],relationship:'citations',
        coverage:{citation_nodes:26,citation_links:25,metadata_papers:2,papers_with_reference_ids:1,reference_identifiers:25}},error:null};
    }
    if(scenario==='citation-timeline' && f.relation==='citations') {
      const graph=Array.from({length:60},(_,i)=>({id:String(900000+i),pmid:String(900000+i),label:i===0?'Radical prostatectomy and long-term functional outcomes: a multicentre prospective study':`Evidence on prostate cancer diagnosis and treatment: a longitudinal cohort investigation ${i+1}`,authors:[['Smith Jane','Lee Min','Johnson David','Park Il Woo'][i%4]],journal:['European Urology','BJU International'][i%2],year:i===59?null:i<6?2000+i*4:2024+i%3,kind:i<6?'reference':'paper',matching_source:i>=6,in_catalog:true,indexed:i>=6,incoming_citations:i<6?9:0,identified_references:i>=6?1:0}));
      const edges=graph.slice(6).map((n,i)=>({source:n.id,target:graph[i%6].id,weight:1}));
      return {data:{...old,relationship:'citations',nodes:graph,edges,filters:f,focus:f.focus,peer:f.peer,citation_selection:[f.focus,f.peer].map(id=>graph.find(n=>n.id===id)).filter(Boolean),
       coverage:{citation_nodes:400,citation_links:600,metadata_papers:90,papers_with_reference_ids:85,reference_identifiers:600,unlinked_papers:1},
       unlinked_papers:[{id:'999999',pmid:'999999',label:'Paper with reference metadata pending',year:2026,authors:['Example Author']}],papers:old.papers,notes:[]},error:null};
    }
    if(scenario==='atlas-reference-targets' && f.relation==='citations') {
      const source={id:papers[0].pmid,pmid:papers[0].pmid,label:papers[0].title,kind:'paper',document_count:1,year:2024,indexed:true,in_catalog:true,matching_source:true};
      const targets=[{id:'99112233',pmid:'99112233',label:'Reference preceding the indexed corpus',year:1998},
        {id:'e'.repeat(24),doi:'10.1234/fixture-reference',label:'DOI-only identified reference',year:null}].map(n=>({...n,kind:'reference',document_count:1,indexed:false,in_catalog:false,matching_source:false}));
      const graph=[source,...targets];
      return {data:{...old,relationship:'citations',nodes:graph,edges:targets.map(n=>({source:source.id,target:n.id,weight:1,reference_ids:['fixture-ref']})),
        filters:f,focus:f.focus,peer:f.peer,selected_documents:1,matched_documents:1,indexed_documents:1,papers:[old.papers[0]],notes:[],
        citation_selection:[f.focus,f.peer].map(id=>graph.find(n=>n.id===id)).filter(Boolean),
        coverage:{citation_nodes:3,citation_links:2,displayed_sources:1,displayed_references:2,metadata_papers:1,papers_with_reference_ids:1,reference_identifiers:2}},error:null};
    }
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
          status: scenario === "knowledge-disambiguation" ? "disambiguation" : scenario === "knowledge-stale" ? "updating" : scenario === "knowledge-indexed" ? "indexed" : "ready",
          updated_at: "2026-10-08T01:00:00Z",
          paragraphs:
            ["knowledge-stale", "knowledge-indexed", "knowledge-disambiguation"].includes(scenario)
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
        meanings: scenario === "knowledge-disambiguation" ? [
          {entity_id:'a'.repeat(24),label:'Prostate Cancer',document_count:5},
          {entity_id:'b'.repeat(24),label:'Principal Component Analysis',document_count:1},
        ] : [],
        papers: papers.slice(0, 3),
        neighbors: nodes
          .filter((n) => n.id !== args.p_id)
          .map((n) => ({ ...n, shared_papers: 8 })),
      },
      error: null,
    };
}
