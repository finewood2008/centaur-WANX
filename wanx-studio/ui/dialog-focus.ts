import{useEffect}from'react';
// Keep keyboard navigation inside the visible modal, then return to its opener.
export function useDialogFocus(key:string){
 useEffect(()=>{
  if(!key)return;
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const frame=requestAnimationFrame(()=>{
   const dialogs=[...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
   const dialog=dialogs.reverse().find(node=>node.getClientRects().length>0);if(!dialog)return;
   dialog.tabIndex=-1;
   const focusable=()=>[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(node=>node.getClientRects().length>0&&!node.closest('[hidden],[inert]'));
   (focusable()[0]||dialog).focus({preventScroll:true});
   const trap=(event:KeyboardEvent)=>{if(event.key!=='Tab')return;const nodes=focusable(),first=nodes[0],last=nodes.at(-1);if(!first){event.preventDefault();dialog.focus();return}if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last!.focus()}else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus()}};
   dialog.addEventListener('keydown',trap);cleanup=()=>dialog.removeEventListener('keydown',trap);
  });
  let cleanup=()=>{};
  return()=>{cancelAnimationFrame(frame);cleanup();if(opener?.isConnected&&!opener.closest('[hidden],[inert]'))opener.focus({preventScroll:true})};
 },[key]);
}
