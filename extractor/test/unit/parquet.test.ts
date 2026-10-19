import { expect,it,vi } from 'vitest';
import { columns, encodePart, orderedRows, physicalSchema, type ParquetEncoder } from '../../src/parquet.js';
import { normalize } from '../../src/rows.js';
import { block,receipt,tx,hash } from '../fixtures.js';
const row=(height=9n)=>{const t=tx(height);return normalize({transaction:t,block:block(height),receipt:receipt(t)},'ETHEREUM');};
it('maps every row to the documented physical schema including nulls',()=>{
  const r=row();const writer=vi.fn<ParquetEncoder>(()=>new ArrayBuffer(4));const out=encodePart([r],writer);
  expect(out.bytes).toHaveLength(4);const opts=writer.mock.calls[0][0] as unknown as {columnData:ReturnType<typeof columns>};
  expect(opts.columnData).toHaveLength(Object.keys(r).length);
  expect(opts.columnData.find(c=>c.name==='maxFeePerGas')).toMatchObject({type:'STRING',nullable:true,data:[null]});
  expect(opts.columnData.find(c=>c.name==='calldataBytes')).toMatchObject({type:'INT32',nullable:false,data:[6]});
  expect(opts.columnData.find(c=>c.name==='value')?.data).toEqual(['0']);
});
it('orders numerically and deduplicates exact identities',()=>{
  const ten=row(10n),two={...row(2n),transactionIndex:'10'},one={...row(2n),transactionHash:hash(201),transactionIndex:'2'};
  expect(orderedRows([ten,two,one,two])).toEqual([one,two,ten]);
  expect(()=>orderedRows([two,{...two,gasUsed:'1'}])).toThrow('Conflicting');
});
it('writes zero rows with the full explicit schema',()=>{
  const writer=vi.fn<ParquetEncoder>(()=>new ArrayBuffer(0));expect(encodePart([],writer).rows).toEqual([]);
  const opts=writer.mock.calls[0][0] as unknown as {columnData:ReturnType<typeof columns>};
  expect(opts.columnData).toHaveLength(physicalSchema.length);expect(opts.columnData.every(c=>c.data.length===0)).toBe(true);
});
it('rejects invalid physical/null values',()=>{
  expect(()=>encodePart([{...row(),gasUsed:null}])).toThrow('schema');
  expect(()=>encodePart([{...row(),calldataBytes:2**31}])).toThrow('schema');
});
