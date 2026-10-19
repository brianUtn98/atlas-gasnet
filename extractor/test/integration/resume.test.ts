import { mkdtemp,readFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect,it } from 'vitest';
import { parquetReadObjects } from 'hyparquet';
import { FileStore,runExtraction,type Store } from '../../src/persistence.js';
import { RPCManager } from '../../src/rpc.js';
import { fixtureClient,selection } from '../fixtures.js';
it('resumes a real temporary run after a durable part precedes its checkpoint',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'atlas-resume-'));
  try{
    const disk=await FileStore.create(directory);let crash=true;
    const interrupted:Store={list:()=>disk.list(),read:name=>disk.read(name),commit:async(name,bytes)=>{await disk.commit(name,bytes);if(crash&&name.endsWith('.parquet')){crash=false;throw Error('interrupted');}}};
    const makeRpc=()=>new RPCManager('ETHEREUM',[fixtureClient()],{retries:0});
    await expect(runExtraction(selection({batchSize:1}),makeRpc(),interrupted)).rejects.toThrow();
    const result=await runExtraction(selection({batchSize:2}),makeRpc(),disk);
    expect(result).toMatchObject({complete:true,rowCount:2});
    const rows=[];
    for(const part of result.parts){const bytes=await readFile(join(directory,part.file));const file=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;rows.push(...await parquetReadObjects({file}));}
    expect(new Set(rows.map(r=>r.chainId+':'+r.transactionHash)).size).toBe(2);
    expect((await readdir(directory)).filter(f=>f.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')).rowCount).toBe(rows.length);
  }finally{await rm(directory,{recursive:true,force:true});}
});
