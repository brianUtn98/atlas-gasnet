import { describe, expect, it, vi } from 'vitest';
import { RPCManager, type RpcBlock } from '../../src/rpc.js';
import { scanRange } from '../../src/extract.js';
import { address, other, hash, selection, tx, block, receipt, fixtureClient } from '../fixtures.js';
const run = (c = fixtureClient(), s = selection()) => scanRange(new RPCManager(s.network,[c],{retries:0}),s);
describe('transaction discovery', () => {
  it('scans inclusive boundaries and a single-block range', async () => {
    const c=fixtureClient(); expect((await run(c)).matches).toHaveLength(2);
    expect(c.getBlock).toHaveBeenNthCalledWith(1,9n); expect(c.getBlock).toHaveBeenNthCalledWith(2,10n);
    expect((await run(fixtureClient(),selection({fromBlock:'10'}))).matches).toHaveLength(1);
  });
  it('selects several recipients, excludes unrelated/intermediary calls and creation', async () => {
    const c=fixtureClient(); const third='0x'+'ef'.repeat(20);
    const transactions=[tx(9n),tx(9n,{hash:hash(901),transactionIndex:1,to:other}),tx(9n,{hash:hash(902),transactionIndex:2,to:third}),tx(9n,{hash:hash(903),transactionIndex:3,to:null})];
    vi.mocked(c.getBlock).mockResolvedValue(block(9n,transactions));
    vi.mocked(c.getReceipt).mockImplementation(async h=>receipt(transactions.find(t=>t.hash===h)!));
    expect((await run(c,selection({toBlock:'9',contracts:[{address},{address:other}]}))).matches).toHaveLength(2);
    expect(c.getReceipt).toHaveBeenCalledTimes(2);
  });
  it('matches signatures/selectors with OR and event filters with AND', async () => {
    const c=fixtureClient(); const topic=hash(123);
    vi.mocked(c.getReceipt).mockResolvedValue(receipt(tx(),{logs:[{address,topics:[topic]}]}));
    const s=selection({toBlock:'9',contracts:[{address,functions:['transfer(address,uint256)','approve(address,uint256)'],eventTopics:[hash(124),topic]}]});
    expect((await run(c,s)).matches).toHaveLength(1);
    vi.mocked(c.getReceipt).mockResolvedValue(receipt(tx(),{logs:[{address:other,topics:[topic]}]}));
    expect((await run(c,s)).matches).toHaveLength(0);
    vi.mocked(c.getReceipt).mockResolvedValue(receipt(tx(),{logs:[{address,topics:[hash(124),topic]}]}));
    expect((await run(c,selection({toBlock:'9',contracts:[{address,eventTopics:[topic]}]}))).matches).toHaveLength(0);
    expect((await run(c,selection({toBlock:'9',contracts:[{address,functions:['0xdeadbeef']}]}))).matches).toHaveLength(0);
  });
  it.each(['0x','0x00','0x000000'])('keeps short calldata %s without functions, filters it otherwise', async input => {
    const c=fixtureClient(),t=tx(9n,{input}); vi.mocked(c.getBlock).mockResolvedValue(block(9n,[t]));vi.mocked(c.getReceipt).mockResolvedValue(receipt(t));
    expect((await run(c,selection({toBlock:'9'}))).matches).toHaveLength(1);
    expect((await run(c,selection({toBlock:'9',contracts:[{address,functions:['0xa9059cbb']}]}))).matches).toHaveLength(0);
  });
  it('keeps reverts unless topic filtering excludes them', async () => {
    const c=fixtureClient();vi.mocked(c.getReceipt).mockResolvedValue(receipt(tx(),{status:'reverted'}));
    expect((await run(c,selection({toBlock:'9'}))).matches[0].receipt.status).toBe('reverted');
    expect((await run(c,selection({toBlock:'9',contracts:[{address,eventTopics:[hash(1)]}]}))).matches).toHaveLength(0);
  });
  it.each([null,{...block(),number:8n},{...block(),hash:'bad'},{...block(),transactions:[{...tx(),blockHash:hash(8)}]},{...block(),transactions:[{...tx(),transactionIndex:1}]},{...block(),transactions:[{...tx(),blockNumber:8n}]}])('aborts on invalid full blocks', async payload => {
    const c=fixtureClient();vi.mocked(c.getBlock).mockResolvedValue(payload as RpcBlock);await expect(run(c)).rejects.toThrow('exhausted');
  });
  it.each([null,{transactionHash:hash(1)},{blockHash:hash(8)},{blockNumber:8n},{transactionIndex:1},{from:address},{to:other},{status:'unknown'},{gasUsed:undefined}])('rejects missing/inconsistent receipts', async patch => {
    const c=fixtureClient();vi.mocked(c.getReceipt).mockResolvedValue(patch===null?null as never:receipt(tx(),patch as never)); await expect(run(c)).rejects.toThrow('exhausted');
  });
  it('anchors receipt fallback to the selected block hash', async () => {
    const a=fixtureClient(),b=fixtureClient();vi.mocked(a.getBlockNumber).mockResolvedValue(110n);
    vi.mocked(a.getReceipt).mockResolvedValue(receipt(tx(),{blockHash:hash(8)}));
    const s=selection({toBlock:'9'});const result=await scanRange(new RPCManager(s.network,[b,a],{retries:0}),s);
    expect(result.matches[0].receipt.blockHash).toBe(result.matches[0].block.hash);
    expect(b.getReceipt).toHaveBeenCalledOnce();expect(a.getReceipt).toHaveBeenCalledOnce();
    vi.mocked(b.getReceipt).mockResolvedValue(receipt(tx(),{blockHash:hash(8)}));
    await expect(scanRange(new RPCManager(s.network,[b,a],{retries:0}),s)).rejects.toThrow('exhausted');
  });
});
