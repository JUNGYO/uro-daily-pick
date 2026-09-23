"""Deterministic, accessible SVG figures from validated numeric results."""
import html
import math


def _svg(title,width,height,content):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title" viewBox="0 0 {width} {height}">'
            f'<title id="title">{html.escape(title)}</title><rect width="100%" height="100%" fill="white"/>'
            '<style>text{font-family:Arial,sans-serif;font-size:12px;fill:#172b4d}.muted{fill:#52657d}</style>'+content+'</svg>')


def _text(x,y,value,extra=''):
    return f'<text x="{x}" y="{y}" {extra}>{html.escape(str(value))}</text>'


def forest(result):
    diagnostic=result.get('config',{}).get('measure')=='SeSp'
    original=result.get('rows',[])
    if not original:return None
    if diagnostic:
        rows=[{'label':r['label']+' · '+label,'estimate':r[key],'ci':r[key+'_ci']} for r in original for key,label in [('sensitivity','Se'),('specificity','Sp')]]
        p=result.get('pooled')
        if p: rows +=[{'label':'Pooled '+label,'estimate':p[key],'ci':p[key+'_ci'],'pooled':True} for key,label in [('sensitivity','Se'),('specificity','Sp')]]
    else:
        rows=[dict(r) for r in original]
        p=result.get('pooled')
        if p:rows.append({'label':'Pooled','estimate':p['display_estimate'],'ci':p['display_ci'],'pooled':True})
    ratio=result.get('config',{}).get('measure') in ('RR','OR','HR')
    transform=math.log if ratio else float
    bounds=[transform(x) for r in rows if r.get('ci') for x in r['ci'] if math.isfinite(x) and (not ratio or x>0)]
    if not bounds:return None
    low,high=(0.,1.) if diagnostic else (min(bounds+[0]),max(bounds+[0]))
    padding=max((high-low)*.08,1e-5);low-=padding;high+=padding
    x=lambda v:290+(transform(v)-low)/(high-low)*380
    width=920;height=84+len(rows)*30
    content=_text(20,25,'Forest plot · '+str(result.get('config',{}).get('measure','')))
    null=1 if ratio else 0
    content+=f'<line x1="{x(null):.2f}" y1="40" x2="{x(null):.2f}" y2="{height-35}" stroke="#94a3b8" stroke-dasharray="4 4"/>'
    for i,r in enumerate(rows):
        y=56+i*30;label=r['label'];content+=_text(18,y+4,label[:37]+('…' if len(label)>37 else ''))
        if not r.get('ci') or r.get('estimate') is None:
            content+=_text(710,y+4,'CI not estimable');continue
        a,b=map(x,r['ci']);e=x(r['estimate'])
        content+=f'<line x1="{a:.2f}" y1="{y}" x2="{b:.2f}" y2="{y}" stroke="#135eb8" stroke-width="2"/>'
        if r.get('pooled'):content+=f'<polygon points="{a:.2f},{y} {e:.2f},{y-6} {b:.2f},{y} {e:.2f},{y+6}" fill="#135eb8"/>'
        else:content+=f'<rect x="{e-3:.2f}" y="{y-3}" width="6" height="6" fill="#135eb8"/>'
        content+=_text(705,y+4,f'{r["estimate"]:.3f} [{r["ci"][0]:.3f}, {r["ci"][1]:.3f}]')
    for i in range(5):
        value=low+(high-low)*i/4;label=math.exp(value) if ratio else value
        content+=_text(290+380*i/4,height-12,f'{label:.3g}','text-anchor="middle"')
    return _svg('Study estimates and 95% confidence intervals',width,height,content)


def prisma(snapshot):
    counts=snapshot.get('counts',{});records=counts.get('records',0);reports=counts.get('reports',0)
    stages=[('Records imported',records),('After duplicate removal',reports),('Reports sought',counts.get('sought',0)),('Included reports',counts.get('included',0)),('Included studies',counts.get('studies',0))]
    content=_text(24,28,'Study selection · recorded project data')
    for i,(label,count) in enumerate(stages):
        y=50+i*95
        content+=f'<rect x="24" y="{y}" width="330" height="65" rx="8" fill="#eff6ff" stroke="#93b4df"/>'
        content+=_text(40,y+25,label)+_text(40,y+48,str(count))
        if i<4:content+=f'<path d="M189,{y+65} v23 m-5,-6 l5,6 5,-6" fill="none" stroke="#52657d"/>'
    exclusions=[('Duplicate records',records-reports),('Title/abstract exclusions',counts.get('ta_excluded',0)),('Reports unavailable',counts.get('unavailable',0)),('Full-text exclusions',counts.get('ft_excluded',0))]
    for i,(label,count) in enumerate(exclusions):content+=_text(380,90+i*95,f'{label}: {count}')
    pending=counts.get('ta_pending',0)+counts.get('ft_pending',0)
    content+=_text(24,555,f'Pending decisions: {pending}. A partial import is not a completed literature search.')
    return _svg('Project selection flow, including incomplete stages',850,580,content)


def funnel(result):
    rows=result.get('diagnostics',{}).get('funnel',[])
    if len(rows)<3:return None
    width,height=680,460;values=[r['estimate'] for r in rows];maxse=max(r['se'] for r in rows)*1.12
    center=(result.get('pooled') or {}).get('estimate',sum(values)/len(values))
    low=min(values+[center-1.96*maxse]);high=max(values+[center+1.96*maxse]);span=max(high-low,1e-10)
    x=lambda v:65+(v-low)/span*550;y=lambda se:45+se/maxse*340
    content=_text(20,24,'Funnel plot · descriptive, not a publication-bias diagnosis')
    content+=f'<path d="M{x(center):.2f},45 L{x(center-1.96*maxse):.2f},385 M{x(center):.2f},45 L{x(center+1.96*maxse):.2f},385" stroke="#94a3b8" stroke-dasharray="4 4" fill="none"/>'
    content+='<path d="M65,45 V385 H615" fill="none" stroke="#334155"/>'
    for r in rows:content+=f'<circle cx="{x(r["estimate"]):.2f}" cy="{y(r["se"]):.2f}" r="4" fill="#135eb8"><title>{html.escape(r["id"])}</title></circle>'
    for i in range(5):
        value=low+span*i/4;content+=_text(x(value),410,f'{value:.3g}','text-anchor="middle"')
        content+=_text(55,y(maxse*i/4)+4,f'{maxse*i/4:.3g}','text-anchor="end"')
    content+=_text(340,439,'Effect on analysis scale','text-anchor="middle"')+_text(15,40,'SE')
    return _svg('Funnel plot of study effect estimates and standard errors',width,height,content)
