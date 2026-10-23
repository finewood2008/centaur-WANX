// Keep intermediate line breaks while typing; normalize only on explicit save.
export const draftLines=value=>String(value).split('\n');
const clean=value=>value.map(line=>line.trim()).filter(Boolean);
export function preparePrdDraft(solution,section){
 const value=structuredClone(solution),p=value.prd;
 for(const field of ['outOfScope','rules','exceptions'])if(Array.isArray(p[field]))p[field]=clean(p[field]);
 for(const scenario of p.scenarios||[])scenario.steps=clean(scenario.steps);
 for(const page of p.pages||[])for(const block of page.blocks){block.fields=clean(block.fields);block.actions=clean(block.actions)}
 if(section==='data')value.fields=p.dataFields.map(f=>f.name).filter(Boolean);
 if(section==='acceptance')value.acceptance=p.tests.map(t=>`${t.title}：${t.given}，${t.when}，${t.then}`);
 return value;
}
