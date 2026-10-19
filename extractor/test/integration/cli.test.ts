import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect,it,vi } from 'vitest';
import { parquetReadObjects } from 'hyparquet';
import { main } from '../../src/cli.js';
import { address,hash,other } from '../fixtures.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const execute=promisify(execFile);
function payload(method:string,params:unknown[]) {
  const h=params[0]==='0xa'?10:9, bh=hash(h),th=hash(h*100);
  if(method==='eth_chainId')return '0x1';
  if(method==='eth_blockNumber')return '0x64';
  if(method==='eth_getBlockByNumber')return {number:'0x'+h.toString(16),hash:bh,timestamp:'0x65000000',transactions:[{hash:th,blockHash:bh,blockNumber:'0x'+h.toString(16),transactionIndex:'0x0',from:other,to:address,nonce:'0x20000000000001',type:'0x0',value:'0x20000000000001',gas:'0x186a0',gasPrice:'0xa',input:'0xa9059cbb00ff'}]};
  if(method==='eth_getTransactionReceipt'){const n=params[0]===hash(1000)?10:9;return {transactionHash:hash(n*100),blockHash:hash(n),blockNumber:'0x'+n.toString(16),transactionIndex:'0x0',from:other,to:address,gasUsed:'0x61a8',cumulativeGasUsed:'0x61a8',effectiveGasPrice:'0xa',status:'0x0',type:'0x0',logs:[]};}
  throw Error('Unexpected RPC method');
}
it('executes compiled help, custom RPC extraction and resume against local HTTP fixtures',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'atlas-cli-'));
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const r=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,result:payload(r.method,r.params??[])}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address() as {port:number}).port;
    await writeFile(join(dir,'rpcs.local.yaml'),`ETHEREUM:\n - http://127.0.0.1:${port}\n`);
    await writeFile(join(dir,'selection.yaml'),JSON.stringify({network:'ETHEREUM',fromBlock:'9',toBlock:'10',contracts:[{address}],outputDir:join(dir,'data'),batchSize:1,retries:0}));
    const cli=join(root,'extractor','dist','cli.js');
    expect((await execute(process.execPath,[cli,'--help'],{cwd:root})).stdout).toContain('--config');
    const args=[cli,'--config',join(dir,'selection.yaml'),'--rpcs',join(dir,'rpcs.local.yaml')];
    for(let i=0;i<2;i++)expect((await execute(process.execPath,args,{cwd:root})).stdout).toContain('2 rows in 2 parts');
    const manifest=JSON.parse(await readFile(join(dir,'data','manifest.json'),'utf8'));
    expect(manifest).toMatchObject({complete:true,rowCount:2});
    expect(JSON.stringify(manifest)).not.toContain('127.0.0.1');
    const bytes=await readFile(join(dir,'data',manifest.parts[0].file));
    const rows=await parquetReadObjects({file:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer});
    expect(rows[0]).toMatchObject({nonce:'9007199254740993',value:'9007199254740993',receiptStatus:'reverted'});
    await expect(execute(process.execPath,[cli,'--unknown'],{cwd:root})).rejects.toThrow();
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await rm(dir,{recursive:true,force:true});}
});
it('runs bundled configuration through the real viem adapter with mocked HTTP, offline',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'atlas-bundled-'));
  const fetchMock=vi.fn(async(_url:unknown,init?:RequestInit)=>{const r=JSON.parse(init!.body as string);return new Response(JSON.stringify({jsonrpc:'2.0',id:r.id,result:payload(r.method,r.params??[])}),{status:200,headers:{'content-type':'application/json'}});});
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  vi.stubGlobal('fetch',fetchMock);
  try{
    const config=join(dir,'selection.yaml');await writeFile(config,JSON.stringify({network:'ETHEREUM',fromBlock:'9',toBlock:'9',contracts:[{address}],outputDir:'out',retries:0}));
    vi.stubEnv('INIT_CWD',dir);
    await main(['--config','selection.yaml']);
    expect(log).toHaveBeenCalledWith('Extraction complete: 1 rows in 1 parts.');
    expect(fetchMock.mock.calls.some(([url])=>String(url).includes('publicnode.com'))).toBe(true);
    expect(JSON.parse(await readFile(join(dir,'out','manifest.json'),'utf8')).rowCount).toBe(1);
  }finally{vi.unstubAllGlobals();vi.unstubAllEnvs();log.mockRestore();await rm(dir,{recursive:true,force:true});}
});
