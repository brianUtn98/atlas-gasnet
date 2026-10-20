import { encodeJson } from '../serialization.js';
import type { OutputContext, OutputStrategy } from './strategy.js';

export class JsonOutputStrategy implements OutputStrategy {
  readonly format = 'json';

  filenames(): string[] {
    return ['transactions.json'];
  }

  async write(context: OutputContext): Promise<void> {
    await context.store.commit('transactions.json', encodeJson(context.rows));
  }
}
