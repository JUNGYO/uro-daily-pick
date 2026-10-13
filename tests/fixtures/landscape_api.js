// Complete deterministic corpus, deliberately larger than the retired 60-node view.
export function landscapeFixture(f, scenario, papers) {
  if(scenario==='landscape-building') return {data:{ready:false},error:null};
  const catalog=Array.from({length:163},(_,i)=>({
    id:i+1,pmid:papers[i]?.pmid||String(700000+i),title:papers[i]?.title||`Catalog paper ${i+1}`,
    journal:i%2?'European urology':'BJU international',pub_date:i===162?null:`${2000+i%27}-01-01`,
    year:i===162?null:2000+i%27,subjects:i===162?[]:i<120?['prostatic neoplasms']:[`subject ${String(i).padStart(3,'0')}`]
  }));
  const base=catalog.filter(p=>(!f.from||p.year>=f.from)&&(!f.to||(p.year!=null&&p.year<=f.to))&&(!f.journal||p.journal===f.journal));
  const scoped=base.filter(p=>!f.subject||p.subjects.includes(f.subject)||(f.subject==='__unassigned__'&&!p.subjects.length));
  const years=(rows)=>[...new Set(rows.map(p=>p.year))].sort((a,b)=>(a??9999)-(b??9999)).map(year=>({year,papers:rows.filter(p=>p.year===year).length}));
  const topics=[...new Set(base.flatMap(p=>p.subjects.length?p.subjects:['__unassigned__']))].filter(t=>!f.subject_q||(t==='__unassigned__'?'no subject metadata':t).includes(f.subject_q.toLowerCase())).map(topic=>{
    const members=base.filter(p=>topic==='__unassigned__'?!p.subjects.length:p.subjects.includes(topic));return {topic,papers:members.length,years:years(members)};
  }).sort((a,b)=>b.papers-a.papers||a.topic.localeCompare(b.topic));
  const selected=scoped.filter(p=>f.paper_year==null||(p.year??0)===f.paper_year).sort((a,b)=>b.id-a.id);
  const shown=selected.filter(p=>f.after==null||p.id<f.after).slice(0,21);
  const source=catalog[0], edges=f.mode==='citations'&&scoped.some(p=>p.id===source.id)?[
    {edge_key:'1:99112233',paper_id:source.id,source_pmid:source.pmid,source_title:source.title,source_year:source.year,target_key:'99112233',target_pmid:'99112233',target_title:'Reference preceding the indexed corpus',target_year:1998,target_id:999,target_status:'current'},
    {edge_key:'1:doi:10.1234/fixture-reference',paper_id:source.id,source_pmid:source.pmid,source_title:source.title,source_year:source.year,target_key:'doi:10.1234/fixture-reference',target_doi:'10.1234/fixture-reference',target_title:null,target_year:null,target_id:null}
  ]:[];
  const chosen=edges.filter(e=>(f.citing_year==null||(e.source_year??0)===f.citing_year)&&(f.target_year==null||(e.target_year??0)===f.target_year));
  return {data:{ready:true,filters:f,coverage:{catalog_papers:catalog.length,matching_papers:base.length,subject_papers:base.filter(p=>p.subjects.length).length,unknown_year:base.filter(p=>p.year==null).length,selected_papers:scoped.length,fulltext_papers:Math.min(scoped.length,70),indexed_papers:Math.min(scoped.length,3),reference_metadata_papers:edges.length?1:0,papers_with_reference_ids:edges.length?1:0,citation_links:edges.length,unknown_target_year_links:edges.filter(e=>e.target_year==null).length},
    years:years(base),journals:[{label:'European urology'},{label:'BJU international'}],subjects:topics.slice(f.subject_page*20,(f.subject_page+1)*20),subject_count:topics.length,subject_page:f.subject_page,
    paper_count:selected.length,papers:shown.slice(0,20),next_after:shown.length>20?shown[19].id:null,
    flows:edges.map(e=>({source_year:e.source_year,target_year:e.target_year,links:1,citing_papers:1})),edge_count:chosen.length,citation_papers:chosen,next_edge:null},error:null};
}
