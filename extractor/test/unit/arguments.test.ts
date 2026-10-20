import { describe, expect, it } from 'vitest';
import { bundledRpcPath, parseArguments } from '../../src/arguments.js';

describe('CLI arguments', () => {
  it('requires selection and defaults to the bundled RPC map', () => {
    expect(parseArguments(['--config', 'selection.yaml'])).toEqual({
      help: false,
      configPath: 'selection.yaml',
      rpcPath: bundledRpcPath,
    });
    expect(bundledRpcPath.replaceAll('\\', '/')).toMatch(/config\/rpcs.public.yaml$/);
  });
  it('uses an explicit replacement RPC path', () =>
    expect(parseArguments(['--rpcs', 'custom.yaml', '--config', 'a.yaml']).rpcPath).toBe(
      'custom.yaml',
    ));
  it.each(['--help', '-h'])('supports %s', (flag) =>
    expect(parseArguments([flag]).help).toBe(true),
  );
  it.each(
    [
      [],
      ['--config'],
      ['--rpcs', 'a'],
      ['--config', '--rpcs'],
      ['--unknown'],
      ['--config', 'a', '--wat'],
      ['--config', 'a', '--config', 'b'],
    ].map((args) => ({ args })),
  )('rejects invalid arguments $args', ({ args }) => expect(() => parseArguments(args)).toThrow());
});
