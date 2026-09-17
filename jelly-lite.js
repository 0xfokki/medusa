// The bell and tentacles of the hero jellyfish on their own, for pages that want her
// presence without the whole hero (no thoughts flying in, no trades, no intake).
// Same sampling and the same light as index.html's buildJellyfish/drawBrain, cut down:
//
//   jellyLite(canvasElement, { points: 9000 })
//
// It breathes, turns slowly, and every few seconds a ring of ice-blue light runs over the
// bell and down one tentacle - the only "signal" here, and it means nothing but presence.
(() => {
"use strict";
function mulberry(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
const clamp=(v,a,b)=>v<a?a:v>b?b:v;

function build(N){
  const g=mulberry(7), A=1, Bq=.82, TH=Math.PI*.5;
  const X=[],Y=[],Z=[],NX=[],NY=[],NZ=[],AL=[],O=[];
  for(let n=0;n<N;n++){
    const u=g(), ang=g()*Math.PI*2, theta=Math.pow(u,.58)*TH;
    const ridge=.72+.28*Math.sin(ang*10+theta*4), shell=ridge*.22+.78+g()*(.94-(ridge*.22+.78));
    const st=Math.sin(theta), ct=Math.cos(theta), ex=st*Math.cos(ang), ez=st*Math.sin(ang), ey=ct;
    X.push(ex*A*shell); Y.push(ey*Bq*shell); Z.push(ez*A*shell);
    const nl=Math.hypot(ex/A,ey/Bq,ez/A)||1; NX.push(ex/A/nl); NY.push(ey/Bq/nl); NZ.push(ez/A/nl);
    AL.push(.62+.38*ridge); O.push((g()*4)|0);
  }
  return { n:N, X:Float32Array.from(X), Y:Float32Array.from(Y), Z:Float32Array.from(Z), NX:Float32Array.from(NX), NY:Float32Array.from(NY), NZ:Float32Array.from(NZ), AL:Float32Array.from(AL), O:Uint8Array.from(O) };
}
function strands(count, pts, len, thick, seed){
  const g=mulberry(seed), arr=[];
  for(let i=0;i<count;i++) arr.push({ ang:(i/count)*Math.PI*2+g()*.15, rim:.97+g()*.05, len:len*(.55+g()*.85), ph:g()*Math.PI*2, freq:.7+g()*.75, thick:thick*(.6+g()*.8), n:pts, surge:0 });
  return arr;
}
const STAMP_S=[[[0,0]],[[0,0],[1,0]],[[0,0],[0,1]],[[0,0],[1,1]]];
const STAMP_L=[[[0,0],[1,0],[0,1],[1,1]],[[0,0],[1,0],[2,0],[1,1]],[[0,0],[0,1],[0,2],[1,1]],[[0,0],[1,1],[1,0],[0,1],[2,1]]];

window.jellyLite = function(canvas, opts={}){
  const ctx=canvas.getContext("2d");
  const B=build(opts.points||9000);
  const tent=strands(11,40,2.2,1,23), orals=strands(4,22,1.15,1.8,29);
  const still=matchMedia("(prefers-reduced-motion: reduce)").matches;
  let DPR=1, W=0, H=0, SZ=0, BX=0, BY=0, scl=1, bcan, bctx, img, buf;
  let yaw=1.46, pitch=.46, last=performance.now(), t0=last, nextSpark=last+1200;
  const rings=[];
  const LX=-.35, LY=.75, LZ=.55, CAM=3.2;

  function resize(){
    DPR=Math.min(2, devicePixelRatio||1);
    const r=canvas.getBoundingClientRect(); W=Math.round(r.width*DPR); H=Math.round(r.height*DPR);
    if(!W||!H) return;
    canvas.width=W; canvas.height=H;
    SZ=Math.round(Math.min(W, H*.78)); BX=W/2; BY=H*.36; scl=SZ*.36;
    bcan=document.createElement("canvas"); bcan.width=bcan.height=SZ; bctx=bcan.getContext("2d");
    img=bctx.createImageData(SZ,SZ); buf=img.data;
  }
  function project(x,y,z,cyw,syw,cpt,spt,s){
    const x1=x*cyw+z*syw, z1=-x*syw+z*cyw, y1=y*cpt-z1*spt, z2=y*spt+z1*cpt, f=CAM/(CAM-z2);
    return { x:BX+x1*s*f, y:BY-y1*s*f, f, z2 };
  }
  function drawBell(now){
    const breathe=1+.035*Math.sin((now-t0)/1000*1.4);
    const cyw=Math.cos(yaw), syw=Math.sin(yaw), cpt=Math.cos(pitch), spt=Math.sin(pitch), half=SZ/2, s=scl*breathe, big=DPR>=1.25;
    buf.fill(0);
    // rings of light across the surface (a shell in 3D around a point on the bell)
    const R=rings.map(w=>{ const t=(now-w.born)/1000, u=t/1.3; return { x:w.x,y:w.y,z:w.z, r:.32*(1-Math.pow(1-u,3)), f:(1-u) }; });
    for(let i=0;i<B.n;i++){
      const x=B.X[i], y=B.Y[i], z=B.Z[i];
      let wi=0;
      for(const w of R){ const ex=x-w.x, ey=y-w.y, ez=z-w.z, q=1-Math.abs(Math.sqrt(ex*ex+ey*ey+ez*ez)-w.r)/.05; if(q>0){ const v=q*q*w.f; if(v>wi) wi=v; } }
      const x1=x*cyw+z*syw, z1=-x*syw+z*cyw, y1=y*cpt-z1*spt, z2=y*spt+z1*cpt, f=CAM/(CAM-z2);
      const px=(half+x1*s*f*(1+wi*.03))|0, py=(half-y1*s*f*(1+wi*.03))|0;
      if(px<1||py<1||px>=SZ-3||py>=SZ-3) continue;
      const depth=clamp((z2+.9)/1.8,0,1);
      const nx=B.NX[i], ny=B.NY[i], nz=B.NZ[i], nx1=nx*cyw+nz*syw, nz1=-nx*syw+nz*cyw, ny1=ny*cpt-nz1*spt, nz2=ny*spt+nz1*cpt;
      const rim=1-Math.abs(nz2), rim2=rim*rim, diff=Math.max(0,nx1*LX+ny1*LY+nz2*LZ);
      const light=(.46+.56*diff+.85*rim2)*B.AL[i];
      let r=150,g=158,b=182; r+=(225-r)*rim2*.22; g+=(232-g)*rim2*.22; b+=(255-b)*rim2*.22;
      let k=(.3+.7*depth*depth)*.8*light;
      if(wi>0){ const w=Math.min(1,wi); r+=(93-r)*w; g+=(183-g)*w; b+=(232-b)*w; k*=1+wi*2.4; }
      r*=k; g*=k; b*=k;
      const st=(big&&depth>.3?STAMP_L:STAMP_S)[B.O[i]];
      for(let q=0;q<st.length;q++){ const idx=((py+st[q][1])*SZ+(px+st[q][0]))*4; buf[idx]+=r; buf[idx+1]+=g; buf[idx+2]+=b; buf[idx+3]=255; }
    }
    bctx.putImageData(img,0,0);
    ctx.globalCompositeOperation="lighter";
    ctx.globalAlpha=.55; ctx.filter="blur("+(7*DPR)+"px)"; ctx.drawImage(bcan,BX-half,BY-half);
    ctx.filter="none"; ctx.globalAlpha=1; ctx.drawImage(bcan,BX-half,BY-half);
    return { cyw,syw,cpt,spt,s };
  }
  function drawStrand(list, core, glow, wobble, t, cam){
    const pts=[];
    for(const sd of list){
      const rimX=Math.cos(sd.ang)*sd.rim, rimZ=Math.sin(sd.ang)*sd.rim, sg=sd.surge?(t*1000-sd.surge)/900:9;
      for(let k=0;k<sd.n;k++){
        const u=k/(sd.n-1), phase=u*sd.freq*6.283+t*1.6+sd.ph, curl=u>.7?(u-.7)/.3:0, fb=1+curl*2.2, ab=1-curl*.35;
        const wa=Math.sin(phase*fb)*wobble*ab*u*u, wb=Math.sin(phase*fb+1.5708)*wobble*.55*ab*u*u;
        const nx=rimX+Math.cos(sd.ang+1.5708)*wa+Math.cos(sd.ang)*wb, nz=rimZ+Math.sin(sd.ang+1.5708)*wa+Math.sin(sd.ang)*wb, ny=-sd.len*u;
        const p=project(nx,ny,nz,cam.cyw,cam.syw,cam.cpt,cam.spt,cam.s);
        if(p.f>.35){
          const pulse=Math.max(0,Math.sin(u*11-t*2.4+sd.ph*3)), surge=sg>=0&&sg<=1?Math.exp(-Math.pow((u-sg)*5,2))*2.8*(1-sg*.4):0;
          pts.push([p.x,p.y,Math.max(0,p.f-.35)/.65*(1-u*.7)*(1+pulse*pulse*1.6+surge),sd.thick*(1.4-u*.9)*DPR]);
        }
      }
    }
    ctx.fillStyle=glow; for(const p of pts){ ctx.globalAlpha=p[2]*.16; ctx.beginPath(); ctx.arc(p[0],p[1],p[3]*2.2,0,6.283); ctx.fill(); }
    ctx.fillStyle=core; for(const p of pts){ ctx.globalAlpha=p[2]*.8; ctx.beginPath(); ctx.arc(p[0],p[1],p[3]*.65,0,6.283); ctx.fill(); }
    ctx.globalAlpha=1;
  }
  function spark(now){
    const i=(Math.random()*B.n)|0;
    rings.push({ x:B.X[i], y:B.Y[i], z:B.Z[i], born:now });
    if(rings.length>3) rings.shift();
    const sd=tent[(Math.random()*tent.length)|0]; sd.surge=now;
    nextSpark=now+1600+Math.random()*2200;
  }
  let visible=true, raf=0;
  function frame(){
    const now=performance.now(), dt=Math.min(.05,(now-last)/1000); last=now;
    if(!W){ resize(); if(!W){ raf=requestAnimationFrame(frame); return; } }
    if(!still){ yaw+=dt*.09; if(now>nextSpark) spark(now); }
    ctx.globalCompositeOperation="source-over"; ctx.clearRect(0,0,W,H);
    const cam=drawBell(now);
    const t=(now-t0)/1000;
    drawStrand(tent,"rgb(210,245,255)","rgb(140,210,255)",.3,t,cam);
    drawStrand(orals,"rgb(240,246,255)","rgb(93,183,232)",.45,t,cam);
    ctx.globalCompositeOperation="source-over";
    for(let i=rings.length-1;i>=0;i--) if(now-rings[i].born>1300) rings.splice(i,1);
    if(!still && visible) raf=requestAnimationFrame(frame);
  }
  resize(); frame();
  addEventListener("resize", () => { resize(); if(still) frame(); });
  if("IntersectionObserver" in window) new IntersectionObserver(es => { visible=es[0].isIntersecting; if(visible && !still){ last=performance.now(); cancelAnimationFrame(raf); raf=requestAnimationFrame(frame); } }).observe(canvas);
};
})();
