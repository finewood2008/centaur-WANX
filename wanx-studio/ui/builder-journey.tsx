import type{ReactNode}from'react';
import type{Project}from'./api';
import{builderJourney}from'./builder-journey-state.mjs';
export function BuilderJourney({project,goal,children}:{project:Project|null;goal?:string;children?:ReactNode}){
 const journey=builderJourney(project);
 return <section className="builder-journey" aria-label="产品制作进度"><div className="journey-explanation" title={goal}><strong>{goal||journey.title}</strong><small>{goal?journey.title+' · ':''}{journey.detail}</small></div>{children}<ol>{journey.steps.map((label:string,i:number)=><li key={label} aria-current={i===journey.step?'step':undefined} className={i===journey.step?'current':i<journey.step?'past':''}><span aria-hidden="true">{i+1}</span>{label}</li>)}</ol></section>;
}
