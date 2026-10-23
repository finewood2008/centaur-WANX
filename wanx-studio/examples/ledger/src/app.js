import './styles.css';
export async function mount(root,api){
  let items=[],filter='全部',editing=null,selected=[];
  const el=(tag,attrs={},text)=>{const n=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k.startsWith('on'))n.addEventListener(k.slice(2).toLowerCase(),v);else n.setAttribute(k,v)}if(text!==undefined)n.textContent=text;return n};
  const fields=[['title','事项标题'],['object','业务对象'],['owner','负责人'],['deadline','截止日期'],['notes','备注']];
  async function load(){items=(await api.data.list({collection:'items'})).items;render()}
  function render(){
    root.replaceChildren();const shell=el('section',{class:'ledger'});root.append(shell);
    shell.append(el('div',{class:'eyebrow'},'BUSINESS WORKSPACE'));
    const top=el('header');top.append(el('h1',{},'把业务进展，整理清楚。'));shell.append(top);
    const sub=el('p',{class:'intro'},'记录每一件重要的事，让下一步一目了然。');shell.append(sub);
    const stats=el('div',{class:'stats'});for(const[label,value]of [['全部事项',items.length],['进行中',items.filter(i=>i.status==='进行中').length],['已完成',items.filter(i=>i.status==='已完成').length]]){const card=el('div');card.append(el('strong',{},String(value)),el('span',{},label));stats.append(card)}shell.append(stats);
    const bar=el('div',{class:'toolbar'});for(const name of ['全部','待处理','进行中','已完成'])bar.append(el('button',{class:filter===name?'active':'',onclick:()=>{filter=name;render()}},name));bar.append(el('button',{class:'primary push',onclick:()=>openForm()},'+ 新建事项'));shell.append(bar);
    const list=el('div',{class:'items'});shell.append(list);
    const shown=items.filter(i=>filter==='全部'||i.status===filter);
    if(!shown.length)list.append(el('div',{class:'empty'},'从第一件业务事项开始。'));
    for(const item of shown){const row=el('article',{class:'item'});const body=el('div');body.append(el('span',{class:'status'},item.status||'待处理'),el('h3',{},item.title||'未命名事项'),el('p',{},[item.object,item.owner,item.deadline].filter(Boolean).join(' · ')));if(item.notes)body.append(el('p',{class:'notes'},item.notes));row.append(body,el('button',{onclick:()=>openForm(item)},'编辑'));list.append(row)}
    const ai=el('section',{class:'ai-card'});ai.append(el('h2',{},'让 AI 帮你看清下一步'),el('p',{},'根据当前台账整理进展与待办。结果作为建议展示，不会自动修改记录。'));
    const actions=el('div',{class:'ai-actions'});actions.append(el('button',{onclick:async()=>{try{selected=await api.files.select();note.textContent=selected.length?'已选择：'+selected.map(f=>f.name).join('、'):'没有选择资料'}catch(e){note.textContent='资料选择暂不可用：'+e.message}}},'选择参考资料'));
    const note=el('p',{class:'notes'});const output=el('div',{class:'ai-output'});const generate=el('button',{class:'primary',onclick:async()=>{generate.disabled=true;output.textContent='正在整理…';try{let reference='';for(const f of selected)reference+='\n'+(await api.files.read(f.id)).text;output.textContent=(await api.model.generate({prompt:'请根据业务台账输出简洁的进展总结与下一步待办。不要声称修改了数据。台账：'+JSON.stringify(items)+'\n参考资料：'+reference})).text}catch(e){output.textContent='暂未生成：'+e.message}finally{generate.disabled=false}}},'汇总进展与待办');actions.append(generate);ai.append(actions,note,output);shell.append(ai);
  }
  function openForm(item){
    editing=item||null;const overlay=el('div',{class:'overlay'}),form=el('form',{class:'form'});form.append(el('h2',{},item?'编辑事项':'新建事项'));const inputs={};
    for(const[key,label]of fields){const wrap=el('label',{},label),input=el(key==='notes'?'textarea':'input',{name:key,type:key==='deadline'?'date':'text'});input.value=item?.[key]||'';if(key==='title')input.required=true;inputs[key]=input;wrap.append(input);form.append(wrap)}
    const select=el('select');for(const status of ['待处理','进行中','已完成'])select.append(el('option',{value:status},status));select.value=item?.status||'待处理';form.append(el('label',{},'状态'),select);const error=el('p',{class:'error'});form.append(error);
    const buttons=el('div',{class:'form-actions'});buttons.append(el('button',{type:'button',onclick:()=>overlay.remove()},'取消'));if(item)buttons.append(el('button',{type:'button',class:'danger',onclick:async e=>{if(e.currentTarget.dataset.confirmed!=='yes'){e.currentTarget.dataset.confirmed='yes';e.currentTarget.textContent='再次点击确认删除';return}try{await api.data.delete({collection:'items',id:item._id,expectedRevision:item._revision});overlay.remove();await load()}catch(e){error.textContent=e.message}}},'删除事项'));buttons.append(el('button',{type:'submit',class:'primary'},'保存事项'));form.append(buttons);form.onsubmit=async e=>{e.preventDefault();try{const value=Object.fromEntries(fields.map(([key])=>[key,inputs[key].value]));value.status=select.value;await api.data.put({collection:'items',id:editing?._id,value,expectedRevision:editing?._revision||0});overlay.remove();await load()}catch(e){error.textContent='保存失败：'+e.message}};overlay.append(form);root.append(overlay)
  }
  await load();
}
