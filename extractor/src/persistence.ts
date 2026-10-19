import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { parquetReadObjects } from 'hyparquet';
import type { Selection } from './config.js';
import { scanRange } from './extract.js';
import { encodePart, physicalSchema } from './parquet.js';
import { audit, features, initialPredictors, normalize, rowKey, schemaVersion, targets, type Row } from './rows.js';
import { assertData, type ReadonlyRPC } from './rpc.js';

export interface Store {
  list(): Promise<string[]>;
  read(name: string): Promise<Uint8Array | null>;
  commit(name: string, bytes: Uint8Array): Promise<void>;
}
export class FileStore implements Store {
  private constructor(private readonly directory: string) {}
  static async create(directory: string): Promise<FileStore> { await mkdir(directory,{recursive:true});return new FileStore(directory); }
  list(): Promise<string[]> { return readdir(this.directory); }
  async read(name: string): Promise<Uint8Array | null> {
    try { return await readFile(join(this.directory,name)); }
    catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error; }
  }
  async commit(name: string, bytes: Uint8Array): Promise<void> {
    const file=join(this.directory,name),temporary=file+'.tmp';
    const handle=await open(temporary,'w');
    try { await handle.writeFile(bytes);await handle.sync(); } finally { await handle.close(); }
    await rename(temporary,file);
    // Windows does not support fsync on directory handles. File contents are synced
    // before rename; on POSIX also sync the directory entry for power-loss durability.
    if(process.platform!=='win32') {const dir=await open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}}
  }
}
export function normalizedSelection(s: Selection) {
  return {version:1,schemaVersion,network:s.network,fromBlock:String(s.fromBlock),toBlock:String(s.toBlock),contracts:s.contracts.map(c=>({address:c.address.toLowerCase(),
    ...(c.functions?{functions:[...new Set(c.functions)].sort()}:{}),...(c.eventTopics?{eventTopics:[...new Set(c.eventTopics)].sort()}:{}),})).sort((a,b)=>a.address.localeCompare(b.address))};
}
const digest=(bytes: Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export const selectionFingerprint=(s: Selection)=>digest(JSON.stringify(normalizedSelection(s)));
export interface Part {file:string;fromBlock:string;toBlock:string;lastBlockHash:string;rows:number;sha256:string}
export interface Checkpoint {version:1;fingerprint:string;selection:ReturnType<typeof normalizedSelection>;batchSize:number;nextBlock:string;parts:Part[]}
const jsonBytes=(v: unknown)=>new TextEncoder().encode(JSON.stringify(v,null,2)+'\n');
const parse=(v: Uint8Array)=>JSON.parse(new TextDecoder().decode(v));
const partName=(from:bigint,to:bigint)=>`part-${from}-${to}.parquet`;
function validateCheckpoint(cp: Checkpoint,s: Selection): void {
  if(cp.version!==1||cp.fingerprint!==selectionFingerprint(s)||JSON.stringify(cp.selection)!==JSON.stringify(normalizedSelection(s))) throw new Error('Incompatible checkpoint selection or schema; use a separate output directory.');
  if(!Number.isSafeInteger(cp.batchSize)||cp.batchSize<1||!Array.isArray(cp.parts))throw new Error('Invalid checkpoint.');
  let next=s.fromBlock;
  for(const part of cp.parts) {
    const end=next+BigInt(cp.batchSize)-1n>s.toBlock?s.toBlock:next+BigInt(cp.batchSize)-1n;
    if(part.fromBlock!==String(next)||part.toBlock!==String(end)||part.file!==partName(next,end)||!Number.isSafeInteger(part.rows)||part.rows<0||!/^0x[0-9a-f]{64}$/.test(part.lastBlockHash)||!/^[0-9a-f]{64}$/.test(part.sha256)||next>s.toBlock)throw new Error('Invalid checkpoint parts.');
    next=end+1n;
  }
  if(cp.nextBlock!==String(next))throw new Error('Invalid checkpoint boundary.');
}
function manifest(cp: Checkpoint,s: Selection) {
  return {schemaVersion,selection:normalizedSelection(s),fingerprint:cp.fingerprint,features,initialPredictors,targets,audit,physicalSchema,
    parts:cp.parts,rowCount:cp.parts.reduce((sum,p)=>sum+p.rows,0),nextBlock:cp.nextBlock,
    lastCommittedBlock:cp.parts.at(-1)?.toBlock??null,lastCommittedBlockHash:cp.parts.at(-1)?.lastBlockHash??null,
    complete:BigInt(cp.nextBlock)>s.toBlock,eventSelectionBias:s.contracts.some(c=>c.eventTopics)?'Topic filters select on execution outcomes and exclude reverted calls without persisted matching logs.':null};
}
async function committedRows(store:Store,cp:Checkpoint): Promise<Map<string,Row>> {
  const seen=new Map<string,Row>();
  for(const part of cp.parts) {
    const bytes=await store.read(part.file);
    if(!bytes||digest(bytes)!==part.sha256)throw new Error('Committed part missing or changed.');
    const file=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
    const rows=await parquetReadObjects({file}) as Row[];
    if(rows.length!==part.rows)throw new Error('Committed row count mismatch.');
    for(const row of rows) {if(seen.has(rowKey(row)))throw new Error('Duplicate committed row.');seen.set(rowKey(row),row);}
  }
  return seen;
}
export async function runExtraction(selection:Selection,rpc:ReadonlyRPC,store:Store):Promise<ReturnType<typeof manifest>> {
  const previous=await store.read('checkpoint.json');
  let cp:Checkpoint;
  if(previous) { cp=parse(previous);validateCheckpoint(cp,selection); }
  else {
    if((await store.list()).some(name=>!name.endsWith('.tmp')))throw new Error('Output directory is not an empty run directory.');
    cp={version:1,fingerprint:selectionFingerprint(selection),selection:normalizedSelection(selection),batchSize:selection.batchSize,nextBlock:String(selection.fromBlock),parts:[]};
    await store.commit('checkpoint.json',jsonBytes(cp));
  }
  try {
    const seen=await committedRows(store,cp);
    const last=cp.parts.at(-1);
    if(last) {
      const height=BigInt(last.toBlock);
      try {const block=await rpc.getBlock(height,b=>assertData(b.hash.toLowerCase()===last.lastBlockHash));assertData(block.hash.toLowerCase()===last.lastBlockHash);}
      catch {throw new Error('Resume block hash changed or could not be verified; progress unchanged.');}
    }
    await store.commit('manifest.json',jsonBytes(manifest(cp,selection)));
    while(BigInt(cp.nextBlock)<=selection.toBlock) {
      const from=BigInt(cp.nextBlock),to=from+BigInt(cp.batchSize)-1n>selection.toBlock?selection.toBlock:from+BigInt(cp.batchSize)-1n;
      const batch=await scanRange(rpc,selection,from,to);
      const rows=batch.matches.map(match=>normalize(match,selection.network));
      for(const row of rows) if(seen.has(rowKey(row)))throw new Error('Transaction identity repeated across committed batches.');
      const encoded=encodePart(rows);
      const part:Part={file:partName(from,to),fromBlock:String(from),toBlock:String(to),lastBlockHash:batch.lastBlock.hash.toLowerCase(),rows:encoded.rows.length,sha256:digest(encoded.bytes)};
      await store.commit(part.file,encoded.bytes);
      const next:Checkpoint={...cp,nextBlock:String(to+1n),parts:[...cp.parts,part]};
      await store.commit('checkpoint.json',jsonBytes(next));
      cp=next;
      for(const row of encoded.rows)seen.set(rowKey(row),row);
      await store.commit('manifest.json',jsonBytes(manifest(cp,selection)));
    }
    return manifest(cp,selection);
  } catch(error) {
    // Reconcile from durable checkpoint after a commit may have succeeded before
    // an injected failure/process interruption was observed by the caller.
    try {const saved=await store.read('checkpoint.json');if(saved){const durable=parse(saved) as Checkpoint;validateCheckpoint(durable,selection);await committedRows(store,durable);await store.commit('manifest.json',jsonBytes(manifest(durable,selection)));}}catch{ /* Preserve original failure; resume retries reconciliation. */ }
    throw error;
  }
}
