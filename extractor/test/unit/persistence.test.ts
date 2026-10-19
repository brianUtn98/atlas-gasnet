import { describe,expect,it,vi } from 'vitest';
import { runExtraction, selectionFingerprint, type Store } from '../../src/persistence.js';
import { RPCManager } from '../../src/rpc.js';
import { features,initialPredictors } from '../../src/rows.js';
import { address,other,hash,selection,fixtureClient,block } from '../fixtures.js';
export class MemoryStore implements Store {
  files=new Map<string,Uint8Array>();
  fault?: (name:string,bytes:Uint8Array,stage:'before'|'after')=>void;
  async list(){return [...this.files.keys()];}
  async read(name:string){return this.files.get(name)??null;}
  async commit(name:string,bytes:Uint8Array){this.fault?.(name,bytes,'before');this.files.set(name,bytes);this.fault?.(name,bytes,'after');}
  json(name:string){return JSON.parse(new TextDecoder().decode(this.files.get(name)));}
}
const rpc=(c=fixtureClient())=>new RPCManager('ETHEREUM',[c],{retries:0});
describe('durable run state',()=>{
  it.each(['before','after'] as const)('replays a part after failure %s part commit without duplicates',async stage=>{
    const store=new MemoryStore();let once=true;
    store.fault=(name,_,when)=>{if(once&&name.endsWith('.parquet')&&when===stage){once=false;throw Error('interruption');}};
    await expect(runExtraction(selection({batchSize:1}),rpc(),store)).rejects.toThrow('interruption');
    expect(store.json('checkpoint.json').nextBlock).toBe('9');expect(store.json('manifest.json').rowCount).toBe(0);
    const result=await runExtraction(selection({batchSize:100}),rpc(),store);
    expect(result).toMatchObject({complete:true,rowCount:2});expect(result.parts.map(p=>p.file)).toEqual(['part-9-9.parquet','part-10-10.parquet']);
    expect(store.json('checkpoint.json').batchSize).toBe(1);
    expect((await store.list()).filter(n=>n.endsWith('.parquet'))).toHaveLength(2);
  });
  it.each(['before','after'] as const)('recovers %s checkpoint commit',async stage=>{
    const store=new MemoryStore();let once=true;
    store.fault=(name,bytes,when)=>{if(once&&name==='checkpoint.json'&&when===stage&&JSON.parse(new TextDecoder().decode(bytes)).parts.length===1){once=false;throw Error('interruption');}};
    await expect(runExtraction(selection({batchSize:1}),rpc(),store)).rejects.toThrow('interruption');
    expect(store.json('manifest.json').rowCount).toBe(stage==='after'?1:0);
    const result=await runExtraction(selection(),rpc(),store);expect(result.rowCount).toBe(2);expect(result.complete).toBe(true);
    expect((await runExtraction(selection(),rpc(),store)).rowCount).toBe(2);
  });
  it('normalizes selections independently of order, duplicates, output and operational options',()=>{
    const a=selection({contracts:[{address,functions:['transfer(address,uint256)','0xa9059cbb'],eventTopics:[hash(2),hash(1)]},{address:other}],batchSize:1});
    const b=selection({contracts:[{address:other},{address,functions:['0xa9059cbb'],eventTopics:[hash(1),hash(2)]}],batchSize:99,outputDir:'another',retries:0});
    expect(selectionFingerprint(a)).toBe(selectionFingerprint(b));
  });
  it.each([{network:'POLYGON'},{fromBlock:'8'},{toBlock:'11'},{contracts:[{address:other}]},{contracts:[{address,functions:['0xa9059cbb']}]},{contracts:[{address,eventTopics:[hash(1)]}]}])('rejects changed selection %j',async patch=>{
    const store=new MemoryStore();await runExtraction(selection(),rpc(),store);
    await expect(runExtraction(selection(patch),rpc(),store)).rejects.toThrow('Incompatible');
  });
  it('rejects changed schema and corrupted boundaries or part bytes',async()=>{
    const store=new MemoryStore();await runExtraction(selection(),rpc(),store);
    const original=store.files.get('checkpoint.json')!;
    const cp=store.json('checkpoint.json');cp.selection.schemaVersion='2';await store.commit('checkpoint.json',new TextEncoder().encode(JSON.stringify(cp)));
    await expect(runExtraction(selection(),rpc(),store)).rejects.toThrow('Incompatible');
    store.files.set('checkpoint.json',original);const p=store.json('checkpoint.json');p.nextBlock='999';store.files.set('checkpoint.json',new TextEncoder().encode(JSON.stringify(p)));
    await expect(runExtraction(selection(),rpc(),store)).rejects.toThrow('boundary');
    store.files.set('checkpoint.json',original);store.files.set('part-9-10.parquet',new Uint8Array([1]));
    await expect(runExtraction(selection(),rpc(),store)).rejects.toThrow('missing or changed');
  });
  it('permits endpoint changes but stops at a changed resume anchor',async()=>{
    const store=new MemoryStore();await runExtraction(selection(),rpc(),store);const saved=store.files.get('checkpoint.json');
    expect((await runExtraction(selection(),rpc(fixtureClient()),store)).complete).toBe(true);
    const changed=fixtureClient();vi.mocked(changed.getBlock).mockImplementation(async h=>({...block(h),hash:hash(999)}));
    await expect(runExtraction(selection(),rpc(changed),store)).rejects.toThrow('Resume block hash');
    expect(store.files.get('checkpoint.json')).toEqual(saved);
  });
  it('does not skip unresolved work after RPC exhaustion and reconciles incomplete counts',async()=>{
    const store=new MemoryStore(),client=fixtureClient();vi.mocked(client.getBlock).mockImplementation(async h=>{if(h===10n)throw Error('https://user:private@secret.test/token');return block(h);});
    await expect(runExtraction(selection({batchSize:1}),rpc(client),store)).rejects.toThrow('exhausted');
    expect(store.json('checkpoint.json').nextBlock).toBe('10');
    expect(store.json('manifest.json')).toMatchObject({complete:false,rowCount:1,nextBlock:'10'});
    expect(JSON.stringify(store.json('manifest.json'))).not.toMatch(/https:|private|secret/);
    const saved=store.files.get('checkpoint.json');
    await expect(runExtraction(selection(),rpc(client),store)).rejects.toThrow();expect(store.files.get('checkpoint.json')).toEqual(saved);
    expect((await runExtraction(selection(),rpc(),store)).rowCount).toBe(2);
  });
  it('advances empty batches and includes all roles without endpoint metadata',async()=>{
    const c=fixtureClient();vi.mocked(c.getBlock).mockImplementation(async h=>block(h,[]));
    const result=await runExtraction(selection({batchSize:1}),rpc(c),new MemoryStore());
    expect(result).toMatchObject({complete:true,rowCount:0,nextBlock:'11',features,initialPredictors});expect(result.parts).toHaveLength(2);
    expect(result.parts.every(p=>p.rows===0)).toBe(true);expect(JSON.stringify(result)).not.toContain('http');
  });
  it('rejects reused output without a checkpoint and duplicate identities across blocks',async()=>{
    const store=new MemoryStore();store.files.set('manifest.json',new Uint8Array());await expect(runExtraction(selection(),rpc(),store)).rejects.toThrow('empty run');
    const c=fixtureClient();let current=9n;vi.mocked(c.getBlock).mockImplementation(async h=>{current=h;const b=block(h);b.transactions[0].hash=hash(900);return b;});
    vi.mocked(c.getReceipt).mockImplementation(async()=>({transactionHash:hash(900),blockHash:hash(Number(current)),blockNumber:current,transactionIndex:0,from:other,to:address,gasUsed:1n,status:'success',logs:[]}));
    const duplicateStore=new MemoryStore();await expect(runExtraction(selection({batchSize:1}),rpc(c),duplicateStore)).rejects.toThrow('repeated across');
    expect(duplicateStore.json('checkpoint.json').nextBlock).toBe('10');
  });
});
