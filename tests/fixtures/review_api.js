// Synthetic browser fixtures only. Numeric correctness is tested against R oracles separately.
const id = n => `10000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
const context = { cohort:"primary", independence_group:"Trial A", outcome:"Mortality", timepoint:"12 months", comparison:"Treatment vs control", unit:"participant", direction:"lower_better", analysis_population:"ITT", adjustment:"unadjusted", value_origin:"reported", value_type:"final" };
export const reviewFixture = {
  calls: [],
  protocol: { version:1, payload:{ question:"Does treatment reduce mortality?", type:"intervention", population:"Adults", intervention:"Treatment", comparator:"Control", outcomes:"Mortality", timepoints:"12 months", eligibility:"Parallel RCTs", search_plan:"PubMed and trial registries", analysis_plan:"Risk ratio with REML", status:"locked" } },
  searches:[{ id:id(8),source:"PubMed",query:"prostate cancer AND randomized",status:"partial",reported_hits:100,revision:1,searched_at:"2026-09-23T00:00:00Z" }],
  reports:[1,2].map(n=>({ id:id(n),project_id:1,paper_id:n,revision:1,bibliography:{ title:`Trial ${n} on treatment outcomes`,authors:["Researcher A"],year:"2025",journal:"Journal of Urology",pmid:String(12345669+n),doi:`10.1000/trial${n}`,abstract:"Randomized trial abstract." },ta_decision:"include",ft_decision:"include",acquisition:"acquired",duplicate_of:null,note:"",exclusion_reason:"",source:{hash:"a".repeat(64),locator:"Table 2"},local_source:{hash:"a".repeat(64)} })),
  studies:[1,2].map(n=>({id:id(10+n),project_id:1,label:`Trial ${n}`,design:"parallel_RCT",population:"Adults",report_ids:[id(n)],revision:1})),
  observations:[1,2].map(n=>({id:id(20+n),project_id:1,study_id:id(10+n),report_id:id(n),kind:"binary",context:{...context,independence_group:`Trial ${n}`},values:{events_t:10*n,n_t:100,events_c:20*n,n_c:100},evidence:{source_hash:"a".repeat(64),source_type:"fulltext",source_checked:true,report_revision:1,locator:"Table 2"},status:"confirmed",revision:1})),
  assessments:[],runs:[],history:[]
};
if(typeof window!=="undefined")window.__reviewFixture=reviewFixture;
export function reviewRpc(name,args,readOnly=false){
  if(!name.startsWith("review_"))return undefined;
  const r=reviewFixture;r.calls.push({name,args});const data=x=>({data:structuredClone(x)});
  if(name==="review_workspace")return data({project_id:1,can_edit:!readOnly,protocol:r.protocol,counts:{records:4,reports:r.reports.length,sought:2,included:2,studies:2,ta_pending:0,ft_pending:0,confirmed:2}});
  if(name==="review_list") { const rows=(r[args.p_section]||[]).filter(x=>!args.p_query||JSON.stringify(x).toLowerCase().includes(args.p_query.toLowerCase()));return data({items:rows.slice((args.p_page||0)*25,((args.p_page||0)+1)*25),total:rows.length}); }
  if(name==="review_analysis")return data(r.runs.find(x=>x.id===args.p_id));
  if(readOnly)return {error:{message:"Project editor required",code:"42501"}};
  if(name==="review_save_protocol"){r.protocol={version:r.protocol.version+1,payload:args.p_payload};return data(r.protocol);}
  if(name==="review_import_records")return data({imported:args.p_items.length,existing_reports:0});
  if(name==="review_start_analysis") {const row={id:args.p_run_id,status:"queued",config:args.p_config,created_at:new Date().toISOString(),input_hash:"b".repeat(64),input_manifest:{observations:r.observations}};r.runs.push(row);return data(row);}
  const kinds={report:"reports",study:"studies",observation:"observations",assessment:"assessments",search:"searches"};
  if(name.startsWith("review_save_")){const key=kinds[name.replace("review_save_","")];if(!key)return undefined;const old=r[key].find(x=>x.id===args.p_id);const row={...old,...args.p_payload,id:args.p_id,revision:(old?.revision||0)+1};if(old)Object.assign(old,row);else r[key].push(row);return data(row);}
  return {error:{message:"Unsupported fixture RPC"}};
}
