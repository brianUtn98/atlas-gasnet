import { fileURLToPath } from 'node:url';

export const bundledRpcPath = fileURLToPath(new URL('../../config/rpcs.public.yaml', import.meta.url));
export const help = 'Usage: npm run extract -- --config <extraction.yaml> [--rpcs <rpcs.yaml>]\n--rpcs replaces the bundled public RPC map. --help shows this message.';
export function parseArguments(args: string[]): { help: boolean; configPath?: string; rpcPath: string } {
  let configPath: string | undefined;
  let rpcPath = bundledRpcPath;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true, rpcPath };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--config', '--rpcs'].includes(key) || seen.has(key)) throw new Error('Unknown or duplicate CLI option; use --help.');
    seen.add(key);
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new Error('Missing CLI option value; use --help.');
    if (key === '--config') configPath = value;
    else rpcPath = value;
  }
  if (!configPath) throw new Error('--config is required; use --help.');
  return { help: false, configPath, rpcPath };
}
