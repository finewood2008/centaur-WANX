// Shared space schemas/text operations preserved from the installed WANX MCP.
import {createHash,randomUUID} from "node:crypto";
const MAX_CHUNK=4*1024*1024;
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const fail=code=>Object.assign(Error(code),{code});
const actions=["describe","stat","list","read","mkdir","move","trash","restore","restore-version","begin-write","write-chunk","commit-write","write-status","cancel-write"];
export const schema = {
  type: "object", additionalProperties: false, required: ["link", "action"],
  properties: {
    link: { type: "string", description: "Exact localhost access link copied from WANX. Never a public URL." },
    action: { type: "string", enum: actions },
    target: { type: "string", description: "Resource ID within the authorized scope; omitted means its root. For mkdir and new writes, the destination folder. stat returns metadata for a known recycled item too, but read cannot read recycled content." },
    parent: { type: "string", description: "For mkdir, alias of target for the destination folder; if both are provided they must match. For move, the destination folder ID within the same scope." }, name: { type: "string" },
    expected: { type: "integer", minimum: 1, description: "Observed resource version, required for move, trash, restore, restore-version and overwrites. trash returns the updated version; use it or query stat before restore. Never guess a version." },
    upload_id: { type: "string" }, size: { type: "integer", minimum: 0 },
    offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: MAX_CHUNK },
    digest: { type: "string" }, data: { type: "string", description: "Base64 chunk" },
  },
};
export async function callTool(name, args, request) {
  const rawRequest = request;
  const binding = Object.fromEntries(['task_id','policy_revision','progress','operation_id'].filter(k=>args[k]!==undefined).map(k=>[k,args[k]]));
  if(args.task_id && !binding.operation_id) binding.operation_id=randomUUID();
  request = input => rawRequest({...binding,...input});
  if (name === "space") return request(args);
  if (name === "space_read_text") {
    const entry = await request({ link: args.link, grant_id: args.grant_id, target: args.target, action: "stat" });
    if (entry.kind !== "file" || entry.size > 1024 * 1024) throw fail("SPACE_TEXT_LIMIT");
    const result = await request({ link: args.link, grant_id: args.grant_id, target: args.target, action: "read", length: 1024 * 1024, expected: entry.version });
    const bytes = Buffer.from(result.data, "base64");
    if (hash(bytes) !== entry.digest) throw fail("SPACE_CHUNK_INVALID");
    return { ...entry, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  }
  if (name !== "space_write_text") throw fail("SPACE_TOOL_NOT_FOUND");
  if (typeof args.text !== "string" || Buffer.byteLength(args.text) > 1024 * 1024) throw fail("SPACE_TEXT_LIMIT");
  const data = Buffer.from(args.text), upload_id = randomUUID().replaceAll("-", "");
  await request({ link: args.link, grant_id: args.grant_id, action: "begin-write", target: args.target, name: args.name, expected: args.expected, upload_id, size: data.length });
  try {
    if (data.length) await request({ link: args.link, grant_id: args.grant_id, action: "write-chunk", upload_id, offset: 0, data: data.toString("base64"), digest: hash(data) });
    return await request({ link: args.link, grant_id: args.grant_id, action: "commit-write", upload_id, digest: hash(data) });
  } catch (error) {
    await request({ link: args.link, grant_id: args.grant_id, action: "cancel-write", upload_id }).catch(() => {});
    throw error;
  }
}
