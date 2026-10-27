export const PANEL_NOTE_METHODS = new Set(['snapshot','note-refresh','note-save','note-paste','capture','preview','choose','transfer','note-command']);
export function panelNoteState(state){
  if(state.data&&state.item)return {data:state.data,item:{id:state.item.id,name:state.item.name,mime:state.item.mime}};
  const {scope,online,boxId,error,note,captured}=state;
  return {scope,online,boxId,error,note,...(state.dataOwnerId?{dataOwnerId:state.dataOwnerId,dataContextId:state.dataContextId}:{}),tasks:(state.tasks||[]).filter(t=>t.kind==='image'),...(captured?{captured}:{}),...(typeof state.text==='string'?{text:state.text}:{})};
}
