import { describe, expect, it } from 'vitest';
import { audit, features, initialPredictors, normalize, targets } from '../../src/rows.js';
import { address, other, tx, block, receipt, hash } from '../fixtures.js';
import type { RpcTransaction } from '../../src/rpc.js';
const row = (patch: Partial<RpcTransaction> = {}) => { const transaction=tx(9n,patch);return normalize({transaction,block:block(9n,[transaction]),receipt:receipt(transaction,{status:'reverted'})},'ETHEREUM'); };
describe('dataset normalization',()=>{
  it('separates submitted terms, gas cap, target and audit',()=>{
    const r=row({value:900719925474099312345n,nonce:9007199254740993n,gasPrice:9007199254740994n});
    expect(r).toMatchObject({value:'900719925474099312345',nonce:'9007199254740993',gasPrice:'9007199254740994',gasLimit:'100000',gasUsed:'25000',maxFeePerGas:null,maxPriorityFeePerGas:null,receiptStatus:'reverted',type:0,accessList:'[]',chainName:'ETHEREUM',chainId:'1'});
  });
  it.each(['eip1559','eip4844','eip7702'])('normalizes %s caps and discards mined gasPrice',type=>{
    expect(row({type,gasPrice:999n,maxFeePerGas:500n,maxPriorityFeePerGas:10n})).toMatchObject({gasPrice:null,maxFeePerGas:'500',maxPriorityFeePerGas:'10'});
  });
  it('supports access-list fees and numeric RPC type encodings',()=>{
    expect(row({type:'eip2930'})).toMatchObject({type:1,gasPrice:'10',maxFeePerGas:null});
    expect(row({type:'0x0'}).type).toBe(0);expect(()=>row({type:'unknown'})).toThrow();
    expect(()=>row({type:'eip1559'})).toThrow();expect(()=>row({gasPrice:undefined})).toThrow();
  });
  it.each([['0x',0,0,0,null],['0x00000000',4,4,0,'0x00000000'],['0xA9059CBB00FF',6,1,5,'0xa9059cbb'],['0x00ff',2,1,1,null]])('counts all calldata %s',(input,total,zero,nonzero,selector)=>{
    const r=row({input:input as string});expect([r.calldataBytes,r.calldataZeroBytes,r.calldataNonzeroBytes,r.functionSelector]).toEqual([total,zero,nonzero,selector]);expect(r.input).toBe((input as string).toLowerCase());
  });
  it('preserves ordered access lists including duplicate key counts',()=>{
    const list=[{address:address.toUpperCase().replace('0X','0x'),storageKeys:[hash(1),hash(1)]},{address:other,storageKeys:[hash(2)]}];
    const r=row({accessList:list});expect(r.accessListAddressCount).toBe(2);expect(r.accessListStorageKeyCount).toBe(3);
    expect(JSON.parse(r.accessList as string)).toEqual([{address,storageKeys:[hash(1),hash(1)]},{address:other,storageKeys:[hash(2)]}]);
    expect(row({accessList:[]}).accessListStorageKeyCount).toBe(0);
  });
  it('keeps native value independent of ERC-20 calldata amounts',()=>{
    expect(row({input:'0xa9059cbb'+'ff'.repeat(64),value:0n}).value).toBe('0');
  });
  it('categorizes chains and excludes every audit/target field from candidate inputs',()=>{
    const t=tx();const r=normalize({transaction:t,block:block(),receipt:receipt(t)},'POLYGON_AMOY');
    expect(r.chainName).toBe('POLYGON_AMOY');expect(r.chainId).toBe('80002');
    expect(initialPredictors).toHaveLength(7);expect(targets).toEqual(['gasUsed']);
    for(const key of [...audit,...targets]) expect(features).not.toContain(key);
    expect([...features,...targets,...audit].sort()).toEqual(Object.keys(r).sort());
  });
});
