"""Power simulation for H1 non-inferiority tests (Section 2.2.7).
Design: 3 sites x 4 blocks x 5 treatments, 2 seasons; plot random effect gives
between-season correlation rho. Run: python3 power_simulation_H1.py (needs numpy, scipy)."""
import numpy as np
from scipy import stats
rng=np.random.default_rng(2026)
L,Bk,T,S=3,4,5,2
# design matrix for plot means: location, block(location), treatment, trt x location
rows=[(l,b,t) for l in range(L) for b in range(Bk) for t in range(T)]
def X():
    cols=[]
    for l,b,t in rows:
        v=[1.0]
        v+=[1.0*(l==k) for k in range(1,L)]
        v+=[1.0*(b==k) for k in range(1,Bk) for _ in [0]]  # block effects nested: build per location
        cols.append(v)
    # build properly nested block-within-location dummies
    M=[]
    for l,b,t in rows:
        v=[1.0]+[1.0*(l==k) for k in range(1,L)]
        v+=[1.0*(l==ll and b==bb) for ll in range(L) for bb in range(1,Bk)]
        v+=[1.0*(t==tt) for tt in range(1,T)]
        v+=[1.0*(t==tt and l==ll) for tt in range(1,T) for ll in range(1,L)]
        M.append(v)
    return np.array(M)
Xm=X(); n,p=Xm.shape; df=n-np.linalg.matrix_rank(Xm)
XtXi=np.linalg.pinv(Xm.T@Xm)
tr=np.array([r[2] for r in rows]); loc=np.array([r[0] for r in rows])
def contrast_est(ym):
    beta=XtXi@Xm.T@ym; res=ym-Xm@beta; s2=res@res/df
    # T1 vs T2 averaged over locations: use cell means (balanced -> difference of treatment means)
    d=ym[tr==0].mean()-ym[tr==1].mean()
    # SE: residual var of plot means * 2/12
    se=np.sqrt(s2*2/12)
    return d,se
tq=stats.t.ppf(0.975,df)
def sim_yield(cv,rho,true_ratio=1.0,margin=0.15,base=3.0,nsim=4000):
    sig=cv*base; hits=0
    mu=np.array([base*true_ratio,base,base,base*0.75,base*0.85])  # T1..T5
    for _ in range(nsim):
        site=rng.normal(0,0.5,L)[loc]; blk=rng.normal(0,0.2,(L,Bk))[loc,[r[1] for r in rows]]
        u=rng.normal(0,np.sqrt(rho)*sig,n)
        ys=np.stack([mu[tr]+site+blk+u+s*0.3+rng.normal(0,np.sqrt(1-rho)*sig,n) for s in range(S)])
        d,se=contrast_est(ys.mean(0))
        if d-tq*se>-margin*base: hits+=1
    return hits/nsim
def sim_count(sl,rho,m0=40,red=0.45,rr_margin=1.35,true_rr=1.0,nsim=3000):
    mu=np.array([m0*(1-red)*true_rr,m0*(1-red),m0*(1-red),m0,m0*0.9]); hits=0; sup=0
    for _ in range(nsim):
        site=rng.normal(0,0.4,L)[loc]; blk=rng.normal(0,0.15,(L,Bk))[loc,[r[1] for r in rows]]
        u=rng.normal(0,np.sqrt(rho)*sl,n)
        ly=[]
        for s in range(S):
            lam=mu[tr]*np.exp(site+blk+u+rng.normal(0,np.sqrt(1-rho)*sl,n))
            ly.append(np.log(rng.poisson(lam)+1))
        ym=np.mean(ly,0)
        # T1 - T2 on log scale: NI if upper limit < log(margin)
        d=ym[tr==0].mean()-ym[tr==1].mean()
        beta=XtXi@Xm.T@ym; res=ym-Xm@beta; s2=res@res/df; se=np.sqrt(s2*2/12)
        if d+tq*se<np.log(rr_margin): hits+=1
        d4=ym[tr==0].mean()-ym[tr==3].mean()
        if d4+tq*se<0: sup+=1
    return hits/nsim, sup/nsim
print('df',df)
for cv in (0.12,0.15,0.18):
    print('yield NI15 cv',cv,[round(sim_yield(cv,r),2) for r in (0.3,0.45,0.6)], ' true -5%:',[round(sim_yield(cv,r,true_ratio=0.95),2) for r in (0.3,0.6)])
for sl in (0.24,0.34):
    print('count sl',sl,[tuple(round(x,2) for x in sim_count(sl,r)) for r in (0.3,0.45,0.6)])
