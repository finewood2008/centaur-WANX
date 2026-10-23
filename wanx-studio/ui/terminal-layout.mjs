export const DEFAULT_TERMINAL_FONT=15;
export function terminalFont(value){const n=Number(value);return value===null||value===''||!Number.isFinite(n)?DEFAULT_TERMINAL_FONT:Math.max(12,Math.min(24,Math.round(n)))}
// Match the fixed PTY grid at a readable font; overflow scrolls, never scales down.
export function terminalDimensions(columns,rows,fontSize){
 const font=terminalFont(fontSize);
 return{width:Math.ceil(columns*font*.62)+24,height:rows*Math.ceil(font*1.4)+18};
}
