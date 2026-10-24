import {Icon} from './icons';
import './question-batch.css';
export type ProductQuestion={id:string;focus?:string;text:string;why:string;options:string[]};
export type ProductAnswer={choice:string;extra?:string};
type Question=ProductQuestion&{choices:{value:string;label:string;description:string;recommended:boolean}[]};

export function QuestionBatch({questions,answers={},disabled,onChange}:{questions:Question[];answers?:Record<string,ProductAnswer>;disabled:boolean;onChange:(answers:Record<string,ProductAnswer>)=>void}){
 const count=questions.filter(q=>answers[q.id]?.choice&&(answers[q.id].choice!=='other'||answers[q.id].extra?.trim())).length;
 return <section className="question-batch" aria-label="本轮产品选择">
  <header><div><span>一起决定这一轮</span><strong>{questions.length} 个产品问题</strong></div><small>已回答 {count} / {questions.length}</small></header>
  <p className="question-batch-note">每题都有推荐，你也可以选择不同方案。确认后，已决定的内容会整理进右侧 PRD。</p>
  <div className="question-batch-grid">{questions.map((q,index)=>{const value=answers[q.id]||{choice:'',extra:''};return <fieldset key={q.id} className={value.choice?'answered':''}>
   <legend><span>{String(index+1).padStart(2,'0')}</span>{q.text}</legend><p className="question-batch-why">{q.why}</p>
   <div role="radiogroup" aria-label={q.text}>{q.choices.map((option,optionIndex)=><button type="button" role="radio" tabIndex={(value.choice?value.choice===option.value:optionIndex===0)?0:-1} onKeyDown={e=>{const step=e.key==='ArrowDown'||e.key==='ArrowRight'?1:e.key==='ArrowUp'||e.key==='ArrowLeft'?-1:0;if(!step)return;e.preventDefault();const next=(optionIndex+step+q.choices.length)%q.choices.length;onChange({...answers,[q.id]:{...value,choice:q.choices[next].value}});(e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next])?.focus()}} aria-checked={value.choice===option.value} key={option.value} disabled={disabled} onClick={()=>onChange({...answers,[q.id]:{...value,choice:option.value}})}>
    <span className="question-radio">{value.choice===option.value&&<Icon name="check" size={12}/>}</span><span><strong>{option.label}{option.recommended&&<em>推荐</em>}</strong>{option.description&&<small>{option.description}</small>}</span>
   </button>)}</div>
   {value.choice==='other'&&<textarea aria-label={'补充回答：'+q.text} rows={2} placeholder="说说你更希望怎样做…" disabled={disabled} value={value.extra||''} onChange={e=>onChange({...answers,[q.id]:{...value,extra:e.target.value}})}/>}
   {value.choice&&<span className="question-choice-state"><Icon name="check" size={12}/>已选择 · 确认整轮回答后写入 PRD</span>}
  </fieldset>})}</div>
 </section>;
}
