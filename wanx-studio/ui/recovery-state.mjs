// Renderer-memory only; recovery can never select a project from another Host scope.
export function createRecoveryState(){
 let scope='',project=null,pending=false;
 return {
  note(nextScope,nextProject){scope=nextScope;project=nextProject},
  arm(){pending=true},
  consume(currentScope){const value=pending&&scope===currentScope?project:null;pending=false;if(scope!==currentScope){scope='';project=null}return value},
  clear(){scope='';project=null;pending=false},
 };
}
export const workspaceRecovery=createRecoveryState();
