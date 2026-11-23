const url = 'https://eth.drpc.org';
async function rpc(method,params) {
 const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
 const v=await r.json(); return {http:r.status,...v};
}
for(const h of [19050936,19050955,19050954]) {
 const b=await rpc('eth_getBlockByNumber',['0x'+h.toString(16),true]);
 const txs=b.result?.transactions?.filter(t=>t.to?.toLowerCase()==='0xdac17f958d2ee523a2206206994597c13d831ec7' && ['0xa9059cbb','0x23b872dd','0x095ea7b3'].includes(t.input.slice(0,10)))??[];
 console.log(JSON.stringify({height:h,http:b.http,transactions:txs.length,errorCode:b.error?.code}));
 for (const t of txs) {
  const r=await rpc('eth_getTransactionReceipt',[t.hash]);const x=r.result;
  const problems=[];
  if(!x) problems.push('null_receipt'); else {
   for(const k of ['transactionHash','blockHash','blockNumber','transactionIndex','from','to']) if(x[k]?.toLowerCase()!==(k==='transactionHash'?t.hash:t[k])?.toLowerCase() && !(x[k]==null&&t[k]==null)) problems.push(k);
   if(!['0x0','0x1'].includes(x.status)) problems.push('status');
   if(!/^0x[0-9a-f]+$/i.test(x.gasUsed??'')) problems.push('gasUsed');
   if(!Array.isArray(x.logs)) problems.push('logs');
  }
  if(problems.length||r.error) console.log(JSON.stringify({height:h,hash:t.hash,http:r.http,errorCode:r.error?.code,problems}));
 }
}
