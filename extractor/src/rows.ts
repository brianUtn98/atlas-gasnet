import { networks, type NetworkName } from './config.js';
import { quantity, transactionType, type Match } from './extract.js';
import { assertData } from './rpc.js';

export const schemaVersion = '1';
export const initialPredictors = ['chainName','to','calldataBytes','functionSelector','calldataNonzeroBytes','value','accessListStorageKeyCount'] as const;
export const features = ['from','to','type','nonce','value','gasLimit','gasPrice','maxFeePerGas','maxPriorityFeePerGas','input','accessList','functionSelector','calldataBytes','calldataZeroBytes','calldataNonzeroBytes','accessListAddressCount','accessListStorageKeyCount','chainName'] as const;
export const targets = ['gasUsed'] as const;
export const audit = ['chainId','transactionHash','blockHash','blockNumber','transactionIndex','blockTimestamp','receiptStatus','schemaVersion'] as const;
export const intColumns = ['type','calldataBytes','calldataZeroBytes','calldataNonzeroBytes','accessListAddressCount','accessListStorageKeyCount'] as const;
export const nullableColumns = ['gasPrice','maxFeePerGas','maxPriorityFeePerGas','functionSelector'] as const;
export type ColumnName = typeof features[number] | typeof targets[number] | typeof audit[number];
export type Row = Record<ColumnName, string | number | null>;
export function normalize(match: Match, network: NetworkName): Row {
  const {transaction:tx,block,receipt} = match;
  const type = transactionType(tx.type);
  assertData(type !== undefined && tx.to !== null);
  const input=tx.input.toLowerCase(), bytes=input.slice(2).match(/../g) ?? [];
  const zero=bytes.filter(b=>b==='00').length;
  const accessList=(tx.accessList ?? []).map(e=>({address:e.address.toLowerCase(),storageKeys:e.storageKeys.map(k=>k.toLowerCase())}));
  const dynamic=type! >= 2;
  return {
    from:tx.from.toLowerCase(),to:tx.to!.toLowerCase(),type:type!,nonce:quantity(tx.nonce),value:quantity(tx.value),gasLimit:quantity(tx.gas),
    gasPrice:dynamic?null:quantity(tx.gasPrice),maxFeePerGas:dynamic?quantity(tx.maxFeePerGas):null,maxPriorityFeePerGas:dynamic?quantity(tx.maxPriorityFeePerGas):null,
    input,accessList:JSON.stringify(accessList),functionSelector:bytes.length>=4?input.slice(0,10):null,
    calldataBytes:bytes.length,calldataZeroBytes:zero,calldataNonzeroBytes:bytes.length-zero,
    accessListAddressCount:accessList.length,accessListStorageKeyCount:accessList.reduce((sum,e)=>sum+e.storageKeys.length,0),
    gasUsed:quantity(receipt.gasUsed),chainName:network,chainId:String(networks[network].id),transactionHash:tx.hash.toLowerCase(),blockHash:block.hash.toLowerCase(),
    blockNumber:quantity(block.number),transactionIndex:quantity(tx.transactionIndex),blockTimestamp:quantity(block.timestamp),receiptStatus:receipt.status,schemaVersion,
  };
}
export const rowKey = (row: Row): string => `${row.chainId}:${row.transactionHash}`;
