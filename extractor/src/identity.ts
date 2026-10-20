import type { Selection } from './config.js';
import { schemaVersion } from './rows.js';
import { digest } from './serialization.js';
import type { NormalizedSelection } from './state.js';

/** Selection identity deliberately excludes output formats and RPC settings. */
export class SelectionIdentity {
  readonly normalized: NormalizedSelection;
  readonly fingerprint: string;

  constructor(selection: Selection) {
    this.normalized = {
      version: 1,
      schemaVersion,
      erc20BalanceEnrichment: selection.erc20BalanceEnrichment,
      network: selection.network,
      fromBlock: String(selection.fromBlock),
      toBlock: String(selection.toBlock),
      contracts: selection.contracts
        .map((contract) => ({
          address: contract.address.toLowerCase(),
          erc20: contract.erc20 ?? false,
          ...(contract.functions ? { functions: [...new Set(contract.functions)].sort() } : {}),
          ...(contract.eventTopics
            ? { eventTopics: [...new Set(contract.eventTopics)].sort() }
            : {}),
        }))
        .sort((left, right) => left.address.localeCompare(right.address)),
    };
    this.fingerprint = digest(JSON.stringify(this.normalized));
  }
}
