// Recovery happens before prompt(), so a failed resume cannot duplicate a model turn.
// read_project supplies the durable conversation and PRD to a fresh session.
export async function interviewSession(conn,{sessionId,cwd,mcpServers},canResume){
 if(sessionId&&canResume){
  try{return{...await conn.loadSession({sessionId,cwd,mcpServers}),sessionId}}
  catch{/* The saved project remains authoritative if the ACP session is unavailable. */}
 }
 return conn.newSession({cwd,mcpServers});
}
