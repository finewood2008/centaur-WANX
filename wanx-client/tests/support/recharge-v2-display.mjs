import assert from 'node:assert/strict';
import { createWalletView } from '../../local-ui/renderer/wallet-view.mjs';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const value=JSON.parse(raw), wrap=data=>({schema_version:'1',request_id:'tb06',data});
const data=new Map(), sent=[];
const view=createWalletView({changed(){},schedule:()=>null,cancel(){},uuid:()=> 'custom-live',
 storage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},
 request:async(action,input)=>{
  sent.push({action,input});
  if(action==='wallet.catalog')return value.catalog;
  if(action==='wallet.balance')return wrap({billing_backend:'qeetoken',balance_credit_atoms:'1876000000',debt_credit_atoms:'0',ledger_sequence:9});
  if(action==='wallet.wallet')return value.wallet;
  if(action==='wallet.usage')return wrap({view_version:'2',account_id:'alice',currency_rule_id:'usd-credit-100-v2',credit_scale:6,remote_sequence:'9',items:[],next_before_sequence:null});
  if(action==='wallet.quote')return value.quote;
  if(action==='wallet.createOrder'){assert.equal(input.amount_fen,1100);assert.equal(input.currency_rule_id,'usd-credit-100-v2');assert.equal('grant_credit_atoms'in input,false);return wrap(value.orders[5]);}
 return wrap({items:[]});
 }});
view.reset(JSON.stringify(['alice','client']));await view.refresh();await view.action('credits-open');
assert.match(view.render(),/187,600\.00/);
assert.equal((view.render().match(/data-action="credits-buy"/g)||[]).length,4);
await view.action('credits-quote',{amount:'11'});assert.match(view.render(),/支付 ¥11 · 到账 1,100\.00 积分/);
await view.action('credits-custom-buy');await view.action('credits-confirm');assert.match(view.render(),/1,100\.00 点积分已记入当前账号/);
assert.doesNotMatch(view.render(),/USD|tokens?|\$/i);
console.log('four tiers; server quote 11 yuan = 1100.00 credits; completed order recovered; final 187600.00; no USD/token');
