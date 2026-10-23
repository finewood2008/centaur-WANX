// Presentation only: entity names, facts and source evidence remain unchanged.
export function referenceNodes(graph) {
  const names = new Set();
  for (const e of graph.edges) for (const v of e.evidence || [])
    for (const match of (v.excerpt || "").matchAll(/(?:^|[\s>*#-])([CJ]\d{2,3})[*\s]*[｜|]/gim))
      names.add(match[1].toUpperCase());
  return new Set(graph.nodes.filter(n => names.has(n.name.toUpperCase())).map(n => n.id));
}

export function selectGraph(graph, { query = "", type = "all", overview = true, focus = null } = {}) {
  const references = referenceNodes(graph);
  const needle = query.trim().toLocaleLowerCase();
  let nodes = graph.nodes.filter(n => (type === "all" || n.type === type) &&
    (needle || !overview || !references.has(n.id) || n.id === focus));
  if (needle) {
    const matches = new Set(nodes.filter(n => n.name.toLocaleLowerCase().includes(needle)).map(n => n.id));
    const neighbors = new Set(matches);
    graph.edges.forEach(e => {
      if (matches.has(e.s)) neighbors.add(e.t);
      if (matches.has(e.t)) neighbors.add(e.s);
    });
    nodes = nodes.filter(n => neighbors.has(n.id));
  }
  if (focus) {
    const neighbors = new Set([focus]);
    graph.edges.forEach(e => {
      if (e.s === focus) neighbors.add(e.t);
      if (e.t === focus) neighbors.add(e.s);
    });
    nodes = nodes.filter(n => neighbors.has(n.id));
  }
  const ids = new Set(nodes.map(n => n.id));
  return { nodes, edges: graph.edges.filter(e => ids.has(e.s) && ids.has(e.t) && (!focus || e.s === focus || e.t === focus)), referenceCount: references.size };
}

export function labelLines(name) {
  const lines = [""];
  let width = 0;
  for (const char of String(name)) {
    const size = /[\u0000-\u007f]/.test(char) ? 0.6 : 1;
    if (width + size > 10) {
      if (lines.length === 2) { lines[1] += "…"; break; }
      lines.push(""); width = 0;
    }
    lines[lines.length - 1] += char; width += size;
  }
  return lines;
}

export function layoutGraph(graph) {
  const degree = new Map(graph.nodes.map(n => [n.id, 0]));
  graph.edges.forEach(e => {
    if (e.s !== e.t) {
      degree.set(e.s, (degree.get(e.s) || 0) + 1);
      degree.set(e.t, (degree.get(e.t) || 0) + 1);
    }
  });
  const nodes = graph.nodes.map(n => ({ ...n, degree: degree.get(n.id), lines: labelLines(n.name) }))
    .sort((a,b) => b.degree - a.degree || a.id.localeCompare(b.id));
  nodes.forEach((n,i) => {
    n.r = Math.min(29, 19 + Math.sqrt(n.degree) * 1.7);
    n.x = 400 + Math.sqrt(i) * 94 * Math.cos(i * 2.39996);
    n.y = 270 + Math.sqrt(i) * 55 * Math.sin(i * 2.39996);
    n.labelWidth = Math.max(...n.lines.map(l => [...l].reduce((w,c) => w + (/[\u0000-\u007f]/.test(c) ? 7.2 : 12), 0)));
  });
  const ids = new Map(nodes.map(n => [n.id,n]));
  const edges = graph.edges.filter(e => ids.has(e.s) && ids.has(e.t));
  // Soft springs and label-aware separation; no wall that piles nodes onto a grid.
  for (let k = 0; k < 360; k++) {
    const forces = new Map(nodes.map(n => [n.id,{ x:(400-n.x)*0.001, y:(270-n.y)*0.009 }]));
    for (let i = 0; i < nodes.length; i++) for (let j = i+1; j < nodes.length; j++) {
      const a=nodes[i], b=nodes[j], dx=a.x-b.x || 0.01, dy=a.y-b.y || 0.01;
      const d=Math.max(1,Math.hypot(dx,dy)), repulsion=3000/(d*d);
      let fx=dx/d*repulsion, fy=dy/d*repulsion;
      const ox=Math.max(a.r+9,a.labelWidth/2)+Math.max(b.r+9,b.labelWidth/2)+16-Math.abs(dx);
      const oy=a.r+b.r+30+8*Math.max(a.lines.length,b.lines.length)-Math.abs(dy);
      if (ox>0 && oy>0) {
        if (ox<oy) fx+=Math.sign(dx)*ox*0.35;
        else fy+=Math.sign(dy)*oy*0.35;
      }
      forces.get(a.id).x+=fx; forces.get(a.id).y+=fy;
      forces.get(b.id).x-=fx; forces.get(b.id).y-=fy;
    }
    edges.forEach(e => {
      if(e.s===e.t) return;
      const a=ids.get(e.s),b=ids.get(e.t),dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
      const f=(d-165)*0.025;
      forces.get(a.id).x+=dx/d*f; forces.get(a.id).y+=dy/d*f;
      forces.get(b.id).x-=dx/d*f; forces.get(b.id).y-=dy/d*f;
    });
    const step=0.8*(1-k/480);
    nodes.forEach(n => {
      const f=forces.get(n.id);
      n.x+=Math.max(-9,Math.min(9,f.x))*step;
      n.y+=Math.max(-9,Math.min(9,f.y))*step;
    });
  }
  return { ...graph, nodes, edges };
}

export function edgeGeometry(a,b,index=0,count=1) {
  if (a.id===b.id) {
    const r=a.r+24+index*18;
    return {d:`M${a.x-a.r*.7} ${a.y-a.r*.7}C${a.x-r*2} ${a.y-r*2} ${a.x+r*2} ${a.y-r*2} ${a.x+a.r*.7} ${a.y-a.r*.7}`,x:a.x,y:a.y-r*1.5,angle:0};
  }
  const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
  const bend=(index-(count-1)/2)*32*(a.id<b.id?1:-1);
  const cx=(a.x+b.x)/2-dy/d*bend,cy=(a.y+b.y)/2+dx/d*bend;
  const start=Math.hypot(cx-a.x,cy-a.y)||1,end=Math.hypot(b.x-cx,b.y-cy)||1;
  const sx=a.x+(cx-a.x)/start*(a.r+3),sy=a.y+(cy-a.y)/start*(a.r+3);
  const tx=b.x-(b.x-cx)/end*(b.r+6),ty=b.y-(b.y-cy)/end*(b.r+6);
  let angle=Math.atan2(dy,dx)*180/Math.PI;
  if (angle>90) angle-=180;
  if (angle< -90) angle+=180;
  return {d:`M${sx} ${sy}Q${cx} ${cy} ${tx} ${ty}`,x:(sx+2*cx+tx)/4,y:(sy+2*cy+ty)/4,angle};
}
