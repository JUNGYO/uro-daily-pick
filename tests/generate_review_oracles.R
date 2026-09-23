# QA only: production calculations are implemented in Python.
# Run with REVIEW_R_LIBRARY pointing to an existing isolated package library.
extra <- Sys.getenv("REVIEW_R_LIBRARY")
if (nzchar(extra)) .libPaths(c(extra, .libPaths()))
library(metafor)
library(lme4)
library(jsonlite)
binary <- data.frame(a=c(4,6,3,62,33,180), b=c(119,300,228,13536,5036,1361),
                     c=c(11,29,11,248,47,372), d=c(128,274,209,12619,5761,1079))
continuous <- data.frame(n1=c(25,37,42,55,61), n2=c(28,40,39,52,59),
 m1=c(4.1,6.2,5.1,7.5,3.6), m2=c(3.1,3.5,4.7,4.8,3.3),
 s1=c(1.2,2.3,1.8,2.1,1.5), s2=c(1.4,1.9,2.1,1.6,1.7))
fit_values <- function(e) {
 z <- rma.uni(yi=e$yi, vi=e$vi, method="REML", test="z", control=list(threshold=1e-10,maxiter=10000))
 f <- if (nrow(e)>2 && z$tau2>0) rma.uni(yi=e$yi, vi=e$vi, method="REML", test="knha", control=list(threshold=1e-10,maxiter=10000)) else z
 list(yi=unname(e$yi),vi=unname(e$vi),estimate=unname(coef(f)),se=unname(f$se),ci=c(f$ci.lb,f$ci.ub),
      tau2=f$tau2,i2=f$I2,q=f$QE,tau2_ci=as.numeric(confint(f)$random[1,2:3]))
}
pairwise <- list()
for (m in c("RR","OR","RD")) {
 e <- escalc(measure=m,ai=a,bi=b,ci=c,di=d,data=binary,add=0,to="none")
 pairwise[[m]] <- fit_values(e)
}
for (m in c("MD","SMD")) {
 e <- escalc(measure=m,n1i=n1,n2i=n2,m1i=m1,m2i=m2,sd1i=s1,sd2i=s2,data=continuous,vtype="LS")
 pairwise[[m]] <- fit_values(e)
}
sparse <- data.frame(a=c(0,6,0,62,33,180),b=binary$b,c=c(11,0,0,248,47,372),d=binary$d)
sparse <- rbind(sparse,data.frame(a=10,b=0,c=12,d=0))
mh <- list()
for (m in c("RR","OR","RD")) {
 selected <- sparse
 if (m %in% c("RR","OR")) selected <- subset(selected,a+c>0)
 if (m=="OR") selected <- subset(selected,b+d>0)
 f <- rma.mh(measure=m,ai=a,bi=b,ci=c,di=d,data=selected,add=0,to="none",drop00=c(TRUE,FALSE))
 mh[[m]] <- list(estimate=unname(coef(f)),se=unname(f$se),ci=c(f$ci.lb,f$ci.ub),k=f$k)
}
set.seed(9281) # Synthetic independent QA data, not clinical evidence.
u <- rnorm(30); v <- -.35*u+sqrt(1-.35^2)*rnorm(30)
nd <- sample(80:220,30); nn <- sample(100:300,30)
tp <- rbinom(30,nd,plogis(1.4+.7*u)); tn <- rbinom(30,nn,plogis(1.8+.6*v))
dta <- data.frame(tp=tp,fn=nd-tp,tn=tn,fp=nn-tn)
k <- nrow(dta)
long <- data.frame(study=factor(rep(seq_len(k),2)), test=factor(rep(c("se","sp"),each=k),levels=c("se","sp")),
                   x=c(dta$tp,dta$tn), n=c(dta$tp+dta$fn,dta$tn+dta$fp))
fit <- glmer(cbind(x,n-x) ~ 0+test+(0+test|study),data=long,family=binomial,nAGQ=1,
 control=glmerControl(optimizer="bobyqa",optCtrl=list(maxfun=200000)))
out <- list(reference=list(R=R.version.string,metafor=as.character(packageVersion("metafor")),lme4=as.character(packageVersion("lme4"))),
 binary=binary,continuous=continuous,pairwise=pairwise,sparse=sparse,mh=mh,
 diagnostic=list(data=dta,logits=unname(fixef(fit)),covariance=unname(as.matrix(vcov(fit))),
 random_covariance=unname(as.matrix(VarCorr(fit)$study)),loglik=as.numeric(logLik(fit)),singular=isSingular(fit)))
write_json(out,"tests/fixtures/review_oracles.json",auto_unbox=TRUE,pretty=TRUE,digits=16)
