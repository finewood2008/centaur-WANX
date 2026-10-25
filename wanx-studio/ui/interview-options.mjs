/** Recognize generic free-text choices without hiding concrete business options. */
export function isSupplementChoice(value){
 return /^(?:其他|其它)(?:$|[\s，,、：:（(])|^other(?:$|[\s,:;(])/i.test(value.trim());
}

/** The composer owns the single free-text entry, including for saved questions. */
export function interviewChoices(options){
 if(!options.length)return [];
 return [...options.filter(value=>!isSupplementChoice(value)).map(value=>{
  const [title,...detail]=value.split('｜');
  const recommended=/[（(]推荐[）)]\s*$/.test(title);
  return {value,label:title.replace(/[（(]推荐[）)]\s*$/,'').trim(),description:detail.join('｜').trim(),recommended};
 }),{value:'other',label:'其他，我来补充',description:'用自己的话说明，或提出不同的方案。',recommended:false}];
}
