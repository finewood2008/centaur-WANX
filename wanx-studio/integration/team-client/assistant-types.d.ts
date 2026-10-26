export interface AssistantSourceContext {
  space: { enabled: boolean; selection?: {mode:'all'|'space'|'folder';space_id?:string;folder_id?:string}; label?:string };
  knowledge: { enabled:boolean; data_scope?:'personal'|'team'; warehouses:Array<{id:string;name?:string}> };
}
export interface AssistantConversation {
  id:string;
  active_thread_id:string;
  revision:number;
  context:AssistantSourceContext;
  versions:Array<{thread_id:string;parent_thread_id?:string|null;target_message_id?:string|null;kind:'original'|'edit'|'regenerate'}>;
  validation_errors:Array<{source:string;id?:string;name:string;code:string}>;
}
export interface AssistantConversationList {
  recent_conversation_id:string|null;
  items:Array<{thread_id:string;active_thread_id:string;title:string;last_active:number;created_at:number}>;
}
export interface AssistantUsage {
  input_tokens?:number; output_tokens?:number; total_tokens?:number;
  cache_read_tokens?:number;cache_write_tokens?:number;reasoning_tokens?:number;
  model_calls?:number;last_input_tokens?:number;
}
export interface AssistantContextUsage {
  used_tokens:number;max_tokens:number;segments:Array<{key:string;tokens:number}>;
}
export type AssistantChannelKind = 'weixin'|'wecom'|'feishu'|'dingtalk';
export interface AssistantChannel {
  id:string; kind:AssistantChannelKind; name:string; enabled:boolean;
  status:'connected'|'connecting'|'disabled'|'error';
}
export interface AssistantChannelDetail {
  channel:AssistantChannel;
  values:Record<string,string>; // Non-secret fields only; blank secrets preserve saved values.
  configured:string[];
}
export interface AssistantChannelQR {
  handle:string; status:'waiting'; interval:number; qr?:string;
}
export type AssistantChannelPoll = {status:'waiting';qr?:string}|{status:'failed'|'expired'}|{status:'success';channel:AssistantChannel};
