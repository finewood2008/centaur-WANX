/** Recognize generic free-text choices without hiding concrete business options. */
export function isSupplementChoice(value){
 return /^(?:其他|其它)(?:$|[\s，,、：:（(])|^other(?:$|[\s,:;(])/i.test(value.trim());
}

/** The composer owns the single free-text entry, including for saved questions. */
export function interviewChoices(options){
 if(!options.length)return [];
 return [...options.filter(value=>!isSupplementChoice(value)).map(value=>({value,label:value})),{value:'other',label:'其他，我来补充'}];
}
