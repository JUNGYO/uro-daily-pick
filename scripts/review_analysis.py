"""Deterministic, typed meta-analysis. No LLM, network, credentials, or source parsing.

The numerical contract is versioned; R is only an independent QA reference.
Input is a frozen project manifest, not user code or a formula expression.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import scipy
from scipy import optimize, special, stats

ENGINE_VERSION = "1.0.0"
PROFILES = {"pairwise-binary-v1", "pairwise-continuous-v1", "pairwise-estimate-v1", "mh-common-binary-v1", "dta-bivariate-v1"}


class AnalysisError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def number(value, *, minimum=None, whole=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise AnalysisError("invalid_number")
    if minimum is not None and value < minimum or whole and int(value) != value:
        raise AnalysisError("invalid_number")
    return float(value)


def validate_input(job):
    if not isinstance(job, dict) or set(job) - {"id", "lease_token", "input_hash", "input", "config"}:
        raise AnalysisError("invalid_request")
    cfg, manifest = job.get("config", {}), job.get("input", {})
    if not isinstance(cfg, dict) or cfg.get("profile") not in PROFILES:
        raise AnalysisError("method_unsupported")
    if not isinstance(manifest, dict): raise AnalysisError("invalid_request")
    rows = manifest.get("observations")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 2000:
        raise AnalysisError("invalid_rows")
    seen, groups, overlap, cohorts = set(), set(), set(), set()
    comparable = ("outcome", "timepoint", "comparison", "unit", "analysis_population", "adjustment")
    for row in rows:
        if not isinstance(row, dict) or row.get("status") != "confirmed":
            raise AnalysisError("unconfirmed_observation")
        ctx, ev = row.get("context", {}), row.get("evidence", {})
        if not isinstance(ctx, dict) or not isinstance(ev, dict) or not isinstance(row.get("values"), dict):
            raise AnalysisError("invalid_observation")
        if row.get("id") in seen or not row.get("id"):
            raise AnalysisError("duplicate_observation")
        if any(not cfg.get(k) or cfg[k] != ctx.get(k) for k in comparable):
            raise AnalysisError("incompatible_context")
        if ev.get("source_checked") is not True or ev.get("source_type") not in {"fulltext", "supplement", "registry", "author_data"}:
            raise AnalysisError("source_not_verified")
        if not isinstance(ev.get("source_hash"), str) or len(ev["source_hash"]) != 64 or any(c not in "0123456789abcdef" for c in ev["source_hash"]) or not ev.get("locator"):
            raise AnalysisError("missing_source")
        if ev.get("report_revision") != row.get("report_revision") or row.get("ft_decision") != "include" or row.get("duplicate_of"):
            raise AnalysisError("source_changed")
        group, shared, cohort = ctx.get("independence_group"), row.get("overlap_group"), (row.get("study_id"), ctx.get("cohort"))
        if not group or group in groups or shared and shared in overlap or cohort in cohorts:
            raise AnalysisError("dependent_observations")
        if any(ctx.get(k) != rows[0]["context"].get(k) for k in ("direction", "value_type")):
            raise AnalysisError("incompatible_scale")
        if row.get("kind") in ("binary", "continuous") and row.get("design") != "parallel_RCT":
            raise AnalysisError("design_adjustment_required")
        if row.get("design") != rows[0].get("design"):
            raise AnalysisError("incompatible_design")
        if row.get("kind") == "effect" and row.get("design") in {"cluster", "crossover", "cohort", "case_control"} and (ctx.get("adjustment") != "adjusted" or not ctx.get("covariates")):
            raise AnalysisError("design_adjustment_required")
        seen.add(row["id"]); groups.add(group); cohorts.add(cohort)
        if shared: overlap.add(shared)
    return cfg, rows


def effect(row, measure):
    v, kind = row["values"], row["kind"]
    if kind == "binary":
        a, n, c, m = [number(v.get(k), minimum=0, whole=True) for k in ("events_t", "n_t", "events_c", "n_c")]
        if n <= 0 or m <= 0 or a > n or c > m:
            raise AnalysisError("invalid_denominator")
        b, d = n-a, m-c
        if measure == "RR":
            if min(a, c) <= 0: raise AnalysisError("sparse_events_require_profile")
            y, var = math.log((a/n)/(c/m)), 1/a-1/n+1/c-1/m
        elif measure == "OR":
            if min(a, b, c, d) <= 0: raise AnalysisError("sparse_events_require_profile")
            y, var = math.log(a*d/(b*c)), 1/a+1/b+1/c+1/d
        elif measure == "RD":
            y, var = a/n-c/m, a*(n-a)/n**3+c*(m-c)/m**3
        else: raise AnalysisError("incompatible_measure")
    elif kind == "continuous":
        n, m = number(v.get("n_t"), minimum=2, whole=True), number(v.get("n_c"), minimum=2, whole=True)
        mt, mc, st, sc = [number(v.get(k)) for k in ("mean_t", "mean_c", "sd_t", "sd_c")]
        if min(st, sc) < 0: raise AnalysisError("invalid_sd")
        if measure == "MD": y, var = mt-mc, st*st/n+sc*sc/m
        elif measure == "SMD":
            df = n+m-2
            pooled = math.sqrt(((n-1)*st*st+(m-1)*sc*sc)/df)
            if pooled == 0: raise AnalysisError("zero_variance")
            correction = math.exp(special.gammaln(df/2)-special.gammaln((df-1)/2))/math.sqrt(df/2)
            y = correction*(mt-mc)/pooled
            var = (n+m)/(n*m)+y*y/(2*(n+m))  # metafor escalc SMD vtype=LS
        else: raise AnalysisError("incompatible_measure")
    elif kind == "effect":
        if measure != v.get("measure") or v.get("scale") != ("log" if measure in {"RR", "OR", "HR"} else "identity"):
            raise AnalysisError("incompatible_effect_scale")
        y, se = number(v.get("estimate")), number(v.get("se"), minimum=1e-12)
        var = se*se
    else: raise AnalysisError("incompatible_kind")
    if not math.isfinite(y) or not math.isfinite(var) or var <= 0:
        raise AnalysisError("zero_or_invalid_variance")
    return y, var


def _tau_reml(y, v):
    def objective(tau):
        w = 1/(v+tau); mean = np.sum(w*y)/np.sum(w)
        return float(0.5*(np.log(v+tau).sum()+math.log(w.sum())+np.sum(w*(y-mean)**2)))
    upper = max(float(np.var(y)), float(np.max(v)), 1e-8)*4
    for _ in range(32):
        if objective(upper*2) >= objective(upper): break
        upper *= 2
    result = optimize.minimize_scalar(objective, bounds=(0, upper), method="bounded", options={"xatol": max(1e-14, upper*1e-12), "maxiter": 1000})
    if not result.success: raise AnalysisError("model_nonconvergence")
    tau = float(result.x)
    return 0.0 if objective(0) <= objective(tau) else tau


def _tau_ci(y, v):
    k = len(y)
    def q(t):
        w=1/(v+t); m=np.sum(w*y)/np.sum(w)
        return float(np.sum(w*(y-m)**2))
    def root(target):
        if q(0) <= target: return 0.0
        hi=max(float(np.var(y)), float(v.max()), 1e-6)
        for _ in range(60):
            if q(hi)<target: return float(optimize.brentq(lambda x:q(x)-target, 0, hi, xtol=1e-13))
            hi*=2
        raise AnalysisError("heterogeneity_interval_failed")
    return [root(stats.chi2.ppf(.975,k-1)), root(stats.chi2.ppf(.025,k-1))]


def _fit_pairwise(y, v):
    k=len(y)
    if k<2: return None
    tau=_tau_reml(y,v); w=1/(v+tau); mean=float(np.sum(w*y)/w.sum()); se_wald=math.sqrt(1/w.sum())
    hk_scale=float(np.sum(w*(y-mean)**2)/(k-1)); se_hk=math.sqrt(hk_scale/w.sum())
    use_hk=k>2 and tau>0
    se=se_hk if use_hk else se_wald; critical=float(stats.t.ppf(.975,k-1) if use_hk else stats.norm.ppf(.975))
    p=float(2*(stats.t.sf(abs(mean/se),k-1) if use_hk else stats.norm.sf(abs(mean/se)))) if se>0 else None
    w0=1/v; m0=float(np.sum(w0*y)/w0.sum()); q=float(np.sum(w0*(y-m0)**2))
    typical=(k-1)/(w0.sum()-np.sum(w0*w0)/w0.sum())
    return {"estimate":mean,"se":se,"ci":[mean-critical*se,mean+critical*se],"p":p,"tau2":tau,"tau2_ci":_tau_ci(y,v),
            "i2":float(100*tau/(tau+typical)),"q":q,"q_p":float(stats.chi2.sf(q,k-1)),"k":k,
            "ci_method":"HKSJ" if use_hk else "Wald","tau2_method":"REML","weights":list(w/w.sum()*100),
            "small_k_sensitivity":{"Wald":[mean-1.959963984540054*se_wald,mean+1.959963984540054*se_wald],
                                   "HKSJ":[mean-stats.t.ppf(.975,k-1)*se_hk,mean+stats.t.ppf(.975,k-1)*se_hk]} if k<=3 else None}


def _scaled(estimate, ci, ratio):
    if not ratio: return float(estimate), [float(x) for x in ci]
    try:
        result=math.exp(float(estimate)), [math.exp(float(x)) for x in ci]
        if not all(math.isfinite(x) for x in [result[0],*result[1]]): raise OverflowError
        return result
    except OverflowError: raise AnalysisError("nonfinite_estimate") from None


def pairwise(cfg, observations):
    measure=cfg["measure"]; ratio=measure in {"RR","OR","HR"}
    expected={"pairwise-binary-v1":"binary","pairwise-continuous-v1":"continuous","pairwise-estimate-v1":"effect"}[cfg["profile"]]
    if any(r["kind"]!=expected for r in observations): raise AnalysisError("incompatible_kind")
    vals=[effect(r,measure) for r in observations]; y=np.array([x[0] for x in vals]); v=np.array([x[1] for x in vals])
    fit=_fit_pairwise(y,v); rows=[]
    for i,row in enumerate(observations):
        ci=[y[i]-1.959963984540054*math.sqrt(v[i]),y[i]+1.959963984540054*math.sqrt(v[i])]
        e,bounds=_scaled(y[i],ci,ratio)
        rows.append({"id":row["id"],"study_id":row["study_id"],"label":row.get("study_label",row["study_id"]),"yi":float(y[i]),"vi":float(v[i]),"estimate":e,"ci":bounds,"weight":float(fit["weights"][i]) if fit else 100.0})
    warnings=[]; loo=[]
    if fit:
        fit["display_estimate"],fit["display_ci"]=_scaled(fit["estimate"],fit["ci"],ratio)
        fit.pop("weights")
        if len(y)>=5 and cfg.get("prediction_interval") is True:
            radius=float(stats.t.ppf(.975,len(y)-1))*math.sqrt(fit["tau2"]+fit["se"]**2)
            _,fit["prediction_interval"]=_scaled(fit["estimate"],[fit["estimate"]-radius,fit["estimate"]+radius],ratio)
        if len(y)<=3: warnings.append("small_k_intervals_are_uncertain")
        if 3<=len(y)<=100:
            for i in range(len(y)):
                f=_fit_pairwise(np.delete(y,i),np.delete(v,i)); est,ci=_scaled(f["estimate"],f["ci"],ratio)
                loo.append({"omitted_id":observations[i]["id"],"estimate":est,"ci":ci,"tau2":f["tau2"]})
    else: warnings.append("single_study_no_pooling")
    diagnostics={"converged":True,"effective_k":len(y),"effect_scale":"log" if ratio else "identity","omitted_rows":[],"continuity_correction":0}
    # Display the funnel descriptively; do not silently select a bias test by k.
    diagnostics["funnel"]=[{"id":r["id"],"estimate":float(y[i]),"se":math.sqrt(v[i])} for i,r in enumerate(observations)]
    diagnostics["asymmetry_test"]="not_requested_or_validated"
    return {"status":"succeeded","rows":rows,"pooled":fit,"diagnostics":diagnostics,"warnings":warnings,"sensitivity":loo}


def mantel_haenszel(cfg, observations):
    """Prespecified common-effect binary synthesis; no continuity correction.

    OR uses the Robins–Breslow–Greenland variance, RR the Greenland–Robins
    variance, and RD the Sato variance. Uninformative double-zero/all-event
    tables are explicitly listed for ratios; RD retains those denominators.
    """
    measure=cfg.get("measure")
    if measure not in {"OR","RR","RD"} or not str(cfg.get("justification","")).strip():
        raise AnalysisError("common_effect_justification_required")
    cells=[]; rows=[]; omitted=[]
    for r in observations:
        if r.get("kind")!="binary": raise AnalysisError("incompatible_kind")
        a,n,c,m=[number(r["values"].get(k),minimum=0,whole=True) for k in ("events_t","n_t","events_c","n_c")]
        if min(n,m)<=0 or a>n or c>m: raise AnalysisError("invalid_denominator")
        b,d=n-a,m-c
        excluded=(measure in {"RR","OR"} and a+c==0) or (measure=="OR" and b+d==0)
        row={"id":r["id"],"study_id":r["study_id"],"label":r.get("study_label",r["study_id"]),"estimate":None,"ci":None,"weight":None,"included":not excluded}
        try:
            yi,vi=effect(r,measure)
            row["estimate"],row["ci"]=_scaled(yi,[yi-1.959963984540054*math.sqrt(vi),yi+1.959963984540054*math.sqrt(vi)],measure!="RD")
        except AnalysisError as error:
            row["interval_unavailable_reason"]=error.code
        if excluded: omitted.append({"id":r["id"],"reason":"uninformative_ratio_table"})
        else: cells.append((a,b,c,d))
        rows.append(row)
    if not cells: raise AnalysisError("no_informative_studies")
    a,b,c,d=np.array(cells,dtype=float).T; n=a+b; m=c+d; total=n+m
    if measure=="OR":
        r=a*d/total; s=b*c/total; R=r.sum(); S=s.sum()
        if min(R,S)<=0: raise AnalysisError("unidentifiable_pooled_ratio")
        p=(a+d)/total; q=(b+c)/total
        estimate=math.log(R/S); variance=.5*((p*r).sum()/R**2+(p*s+q*r).sum()/(R*S)+(q*s).sum()/S**2)
    elif measure=="RR":
        R=(a*m/total).sum(); S=(c*n/total).sum()
        if min(R,S)<=0: raise AnalysisError("unidentifiable_pooled_ratio")
        estimate=math.log(R/S); variance=((n*m/total**2)*(a+c)-a*c/total).sum()/(R*S)
    else:
        denominator=(n*m/total).sum(); estimate=float((a*m/total-c*n/total).sum()/denominator)
        variance=(estimate*(c*(n/total)**2-a*(m/total)**2+n*m*(m-n)/(2*total**2)).sum()+((a*(m-c)+c*(n-a))/total).sum()/2)/denominator**2
    if variance<=0 or not math.isfinite(variance): raise AnalysisError("zero_or_invalid_variance")
    se=math.sqrt(variance); ci=[estimate-1.959963984540054*se,estimate+1.959963984540054*se]
    display,bounds=_scaled(estimate,ci,measure!="RD")
    pooled={"estimate":estimate,"se":se,"ci":ci,"display_estimate":display,"display_ci":bounds,"p":float(2*stats.norm.sf(abs(estimate/se))),"k":len(cells),"ci_method":"Wald","model":"Mantel-Haenszel common effect"}
    return {"status":"succeeded","rows":rows,"pooled":pooled if len(cells)>1 else None,"diagnostics":{"effective_k":len(cells),"continuity_correction":0,"omitted_rows":omitted},
            "warnings":["single_study_no_pooling"] if len(cells)==1 else [],"sensitivity":[]}


def exact_binomial(x,n):
    return [0.0 if x==0 else float(stats.beta.ppf(.025,x,n-x+1)),1.0 if x==n else float(stats.beta.ppf(.975,x+1,n-x))]


def _dta_marginal(theta, y, n):
    mu=np.asarray(theta[:2]); sd=np.exp(theta[2:4]); rho=np.tanh(theta[4])
    sigma=np.array([[sd[0]**2,rho*sd[0]*sd[1]],[rho*sd[0]*sd[1],sd[1]**2]])
    inv=np.linalg.inv(sigma); b=np.zeros_like(y); total=0.0
    def objective(z):
        eta=mu+z
        return np.sum(n*np.logaddexp(0,eta)-y*eta,axis=1)+.5*np.einsum('ni,ij,nj->n',z,inv,z)
    for _ in range(60):
        p=special.expit(mu+b); g=n*p-y+b@inv
        h=np.broadcast_to(inv,(len(y),2,2)).copy(); h[:,0,0]+=n[:,0]*p[:,0]*(1-p[:,0]); h[:,1,1]+=n[:,1]*p[:,1]*(1-p[:,1])
        step=np.linalg.solve(h,g[...,None])[...,0]
        if float(np.max(np.abs(g)))<1e-7: break
        scale=np.ones(len(y)); prior=objective(b)
        for _ in range(24):
            nxt=b-scale[:,None]*step; good=objective(nxt)<=prior+1e-12
            if good.all(): break
            scale[~good]*=.5
        b=nxt
    else: raise AnalysisError("conditional_mode_nonconvergence")
    p=special.expit(mu+b); h=np.broadcast_to(inv,(len(y),2,2)).copy()
    h[:,0,0]+=n[:,0]*p[:,0]*(1-p[:,0]); h[:,1,1]+=n[:,1]*p[:,1]*(1-p[:,1])
    signs,logdet=np.linalg.slogdet(h)
    if not np.all(signs>0): raise AnalysisError("invalid_hessian")
    total=objective(b).sum()+.5*len(y)*np.linalg.slogdet(sigma)[1]+.5*logdet.sum()
    return float(total)


def _hessian(fun,x):
    steps=1e-4*np.maximum(1,np.abs(x)); h=np.zeros((len(x),len(x))); f0=fun(x)
    for i in range(len(x)):
        ei=np.zeros(len(x));ei[i]=steps[i]
        h[i,i]=(fun(x+ei)-2*f0+fun(x-ei))/steps[i]**2
        for j in range(i):
            ej=np.zeros(len(x));ej[j]=steps[j]
            h[i,j]=h[j,i]=(fun(x+ei+ej)-fun(x+ei-ej)-fun(x-ei+ej)+fun(x-ei-ej))/(4*steps[i]*steps[j])
    return h


def diagnostic(cfg, observations):
    if cfg.get("measure")!="SeSp" or any(r["kind"]!="diagnostic" for r in observations): raise AnalysisError("incompatible_kind")
    for key in ("index_test","threshold","reference_standard"):
        if not observations[0]["context"].get(key) or any(r["context"].get(key)!=observations[0]["context"][key] for r in observations): raise AnalysisError("incompatible_diagnostic_definition")
    values=[]; rows=[]
    for r in observations:
        tp,fp,fn,tn=[number(r["values"].get(k),minimum=0,whole=True) for k in ("tp","fp","fn","tn")]
        if tp+fn==0 or tn+fp==0: raise AnalysisError("invalid_denominator")
        values.append([tp,tn,tp+fn,tn+fp]); rows.append({"id":r["id"],"study_id":r["study_id"],"label":r.get("study_label",r["study_id"]),
         "sensitivity":tp/(tp+fn),"specificity":tn/(tn+fp),"sensitivity_ci":exact_binomial(tp,tp+fn),"specificity_ci":exact_binomial(tn,tn+fp)})
    if len(rows)==1: return {"status":"succeeded","rows":rows,"pooled":None,"diagnostics":{"effective_k":1},"warnings":["single_study_no_pooling"],"sensitivity":[]}
    arr=np.array(values);y,n=arr[:,:2],arr[:,2:]; mean=np.clip(y.sum(axis=0)/n.sum(axis=0),.001,.999)
    objective=lambda x:_dta_marginal(x,y,n)
    fits=[]
    for rho in (0.,-.5,.5):
        x=np.r_[special.logit(mean),[-.5,-.5,rho]]
        try:
            f=optimize.minimize(objective,x,method="L-BFGS-B",bounds=[(-12,12),(-12,12),(-7,3),(-7,3),(-4,4)],options={"ftol":1e-12,"gtol":1e-6,"maxiter":700,"maxls":40})
            if f.success and np.isfinite(f.fun): fits.append(f)
        except (AnalysisError,np.linalg.LinAlgError,FloatingPointError): continue
    if not fits: return {"status":"needs_review","rows":rows,"pooled":None,"diagnostics":{"converged":False,"effective_k":len(rows)},"warnings":["model_nonconvergence"],"sensitivity":[]}
    fit=min(fits,key=lambda f:f.fun); x=fit.x
    diagnostics={"converged":True,"effective_k":len(rows),"model":"bivariate_binomial_logit_normal","integration":"Laplace","optimizer":"L-BFGS-B","successful_starts":len(fits),"objective":float(fit.fun),"continuity_correction":0}
    boundary=bool(any(x[i]<-6.9 or x[i]>2.9 for i in (2,3)) or abs(x[4])>3.9)
    warnings=[]
    if boundary: warnings.append("boundary_variance_or_correlation")
    if len(rows)<5: warnings.append("small_k_methodological_review_required")
    if len(fits)<2 or max(abs(f.fun-fit.fun) for f in fits)>1e-4: warnings.append("optimizer_start_disagreement")
    try:
        h=_hessian(objective,x); eig=np.linalg.eigvalsh(h)
        diagnostics["hessian_min_eigenvalue"]=float(eig.min())
        if eig.min()<=1e-7: raise np.linalg.LinAlgError
        covariance=np.linalg.inv(h)[:2,:2]; se=np.sqrt(np.diag(covariance))
        pooled={"sensitivity":float(special.expit(x[0])),"specificity":float(special.expit(x[1])),
                "sensitivity_ci":list(special.expit(x[0]+np.array([-1,1])*1.959963984540054*se[0])),
                "specificity_ci":list(special.expit(x[1]+np.array([-1,1])*1.959963984540054*se[1])),
                "logits":list(x[:2]),"covariance":covariance.tolist(),"tau2":list(np.exp(2*x[2:4])),"rho":float(np.tanh(x[4])),"ci_method":"logit_Wald"}
    except np.linalg.LinAlgError:
        pooled=None; warnings.append("invalid_covariance_no_interval")
    diagnostics["boundary_fit"]=boundary
    return {"status":"needs_review" if warnings else "succeeded","rows":rows,"pooled":pooled,"diagnostics":diagnostics,"warnings":warnings,"sensitivity":[]}


def analyze(job):
    engine={"name":"uro-review-python","version":ENGINE_VERSION,"numpy":np.__version__,"scipy":scipy.__version__,"code_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    if not isinstance(job,dict): job={}
    base={"schema_version":1,"input_hash":job.get("input_hash"),"engine":engine,"config":job.get("config",{}),"artifacts":{}}
    try:
        cfg,rows=validate_input(job)
        result=diagnostic(cfg,rows) if cfg["profile"]=="dta-bivariate-v1" else mantel_haenszel(cfg,rows) if cfg["profile"]=="mh-common-binary-v1" else pairwise(cfg,rows)
        result={**base,**result}
        json.dumps(result,allow_nan=False)
        return result
    except (AnalysisError,np.linalg.LinAlgError,OverflowError,FloatingPointError,ValueError,KeyError,TypeError) as error:
        code=error.code if isinstance(error,AnalysisError) else "numerical_failure"
        return {**base,"status":"failed","rows":[],"pooled":None,"diagnostics":{},"warnings":[],"sensitivity":[],"error_code":code}


if __name__=="__main__":
    import sys
    request=json.load(sys.stdin)
    print(json.dumps(analyze(request),ensure_ascii=False,allow_nan=False))
