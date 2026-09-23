import copy
import json
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from review_analysis import analyze, effect, AnalysisError
import numpy as np

ORACLE=json.loads((Path(__file__).parent/"fixtures/review_oracles.json").read_text())


def job_for(kind, values, measure):
    context={"outcome":"mortality","timepoint":"12 months","comparison":"A vs B","unit":"persons",
             "analysis_population":"ITT","adjustment":"unadjusted","direction":"higher_worse","value_type":"endpoint",
             "index_test":"index","reference_standard":"reference","threshold":"prespecified"}
    profiles={"binary":"pairwise-binary-v1","continuous":"pairwise-continuous-v1","effect":"pairwise-estimate-v1","diagnostic":"dta-bivariate-v1"}
    rows=[]
    for i,value in enumerate(values):
        rows.append({"id":str(i),"study_id":str(i),"study_label":"Study "+str(i+1),"report_revision":1,"ft_decision":"include",
                     "design":"parallel_RCT","status":"confirmed","kind":kind,"values":value,
                     "context":{**context,"cohort":"main","independence_group":str(i)},
                     "evidence":{"source_checked":True,"source_type":"fulltext","source_hash":"a"*64,"locator":"Table 2, row 3","report_revision":1}})
    return {"input_hash":"b"*64,"input":{"observations":rows},"config":{**context,"profile":profiles[kind],"measure":measure,"prediction_interval":True}}


def binary_values(source="binary"):
    return [{"events_t":r["a"],"n_t":r["a"]+r["b"],"events_c":r["c"],"n_c":r["c"]+r["d"]} for r in ORACLE[source]]


class ReviewAnalysisTests(unittest.TestCase):
    def test_pairwise_against_metafor(self):
        for measure in ("RR","OR","RD","MD","SMD"):
            with self.subTest(measure=measure):
                if measure in {"MD","SMD"}:
                    values=[dict(n_t=r["n1"],n_c=r["n2"],mean_t=r["m1"],mean_c=r["m2"],sd_t=r["s1"],sd_c=r["s2"]) for r in ORACLE["continuous"]]
                    job=job_for("continuous",values,measure)
                else: job=job_for("binary",binary_values(),measure)
                result=analyze(job); ref=ORACLE["pairwise"][measure]
                self.assertEqual(result["status"],"succeeded",result)
                for field in ("yi","vi"):
                    np.testing.assert_allclose([r[field] for r in result["rows"]],ref[field],rtol=1e-9,atol=1e-10)
                for field in ("estimate","se","ci","tau2","i2","q"):
                    np.testing.assert_allclose(result["pooled"][field],ref[field],rtol=2e-5,atol=2e-7,err_msg=field)
                np.testing.assert_allclose(result["pooled"]["tau2_ci"],ref["tau2_ci"],rtol=3e-4,atol=3e-5)

    def test_mh_sparse_against_metafor(self):
        for measure in ("RR","OR","RD"):
            with self.subTest(measure=measure):
                job=job_for("binary",binary_values("sparse"),measure)
                job["config"].update(profile="mh-common-binary-v1",justification="Prespecified common effect")
                result=analyze(job);ref=ORACLE["mh"][measure]
                self.assertEqual(result["status"],"succeeded",result)
                for field in ("estimate","se","ci","k"):
                    np.testing.assert_allclose(result["pooled"][field],ref[field],rtol=1e-10,atol=1e-12,err_msg=field)
                self.assertEqual(result["diagnostics"]["continuity_correction"],0)

    def test_diagnostic_against_lme4(self):
        result=analyze(job_for("diagnostic",ORACLE["diagnostic"]["data"],"SeSp"))
        self.assertEqual(result["status"],"succeeded",result)
        ref=ORACLE["diagnostic"]
        np.testing.assert_allclose(result["pooled"]["logits"],ref["logits"],rtol=1e-4,atol=1e-4)
        np.testing.assert_allclose(result["pooled"]["covariance"],ref["covariance"],rtol=.01,atol=1e-4)
        np.testing.assert_allclose(result["pooled"]["tau2"],np.diag(ref["random_covariance"]),rtol=.002,atol=1e-4)

    def test_source_and_independence_fail_closed(self):
        original=job_for("binary",binary_values(),"RR")
        changes=[("status","draft","unconfirmed_observation"),("ft_decision","exclude","source_changed")]
        for field,value,code in changes:
            job=copy.deepcopy(original);job["input"]["observations"][0][field]=value
            self.assertEqual(analyze(job)["error_code"],code)
        job=copy.deepcopy(original);job["input"]["observations"][1]["context"]["independence_group"]="0"
        self.assertEqual(analyze(job)["error_code"],"dependent_observations")
        job=copy.deepcopy(original);job["input"]["observations"][0]["evidence"]["source_checked"]=False
        self.assertEqual(analyze(job)["error_code"],"source_not_verified")
        job=copy.deepcopy(original);job["input"]["observations"][0]["context"]["timepoint"]="24 months"
        self.assertEqual(analyze(job)["error_code"],"incompatible_context")

    def test_no_imputation_or_automatic_continuity_correction(self):
        for value in (None,True,"2",math.inf,math.nan,-1):
            job=job_for("binary",binary_values(),"RR");job["input"]["observations"][0]["values"]["events_t"]=value
            self.assertEqual(analyze(job)["status"],"failed")
        result=analyze(job_for("binary",binary_values("sparse"),"RR"))
        self.assertEqual(result["error_code"],"sparse_events_require_profile")

    def test_single_study_never_implies_meta_analysis(self):
        result=analyze(job_for("binary",binary_values()[:1],"RR"))
        self.assertEqual(result["status"],"succeeded")
        self.assertIsNone(result["pooled"])
        self.assertIn("single_study_no_pooling",result["warnings"])

    def test_reported_effect_stays_on_declared_scale(self):
        job=job_for("effect",[{"measure":"HR","scale":"log","estimate":math.log(.75),"se":.12}],"HR")
        self.assertAlmostEqual(analyze(job)["rows"][0]["estimate"],.75)
        job["input"]["observations"][0]["values"]["scale"]="identity"
        self.assertEqual(analyze(job)["error_code"],"incompatible_effect_scale")


if __name__=="__main__": unittest.main()
