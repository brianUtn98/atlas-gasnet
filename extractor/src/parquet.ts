import { parquetWriteBuffer, type ColumnSource } from 'hyparquet-writer';
import { audit, features, intColumns, nullableColumns, rowKey, schemaVersion, targets, type Row } from './rows.js';

const integerNames = new Set<string>(intColumns), nullableNames = new Set<string>(nullableColumns);
export const physicalSchema = [...features,...targets,...audit].map(name=>({name,type:integerNames.has(name)?'INT32' as const:'STRING' as const,nullable:nullableNames.has(name)}));
export function orderedRows(rows: Row[]): Row[] {
  const unique = new Map<string,Row>();
  for(const row of rows) {
    const key=rowKey(row), previous=unique.get(key);
    if (previous && physicalSchema.some(c=>previous[c.name]!==row[c.name])) throw new Error('Conflicting duplicate row identity.');
    unique.set(key,row);
  }
  const compare=(a: unknown,b: unknown) => BigInt(a as string)<BigInt(b as string)?-1:BigInt(a as string)>BigInt(b as string)?1:0;
  return [...unique.values()].sort((a,b)=>compare(a.chainId,b.chainId)||compare(a.blockNumber,b.blockNumber)||compare(a.transactionIndex,b.transactionIndex));
}
export function columns(rows: Row[]): ColumnSource[] {
  return physicalSchema.map(c=>({ ...c,data:rows.map(row=>{
    const value=row[c.name];
    if(value===null && c.nullable) return null;
    if(c.type==='INT32' ? typeof value!=='number'||!Number.isInteger(value)||value<0||value>2_147_483_647 : typeof value!=='string') throw new Error('Row does not match Parquet schema.');
    return value;
  }) }));
}
export type ParquetEncoder = (options: Parameters<typeof parquetWriteBuffer>[0]) => ArrayBuffer;
export function encodePart(rows: Row[], writer: ParquetEncoder = parquetWriteBuffer): { bytes: Uint8Array; rows: Row[] } {
  const sorted=orderedRows(rows);
  const buffer=writer({columnData:columns(sorted),codec:'UNCOMPRESSED',kvMetadata:[{key:'atlas.schemaVersion',value:schemaVersion}]});
  return {bytes:new Uint8Array(buffer),rows:sorted};
}
