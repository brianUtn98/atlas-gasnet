import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bundledRpcPath } from '../../src/arguments.js';
import { networks, parseYaml, validateRpcs, type NetworkName } from '../../src/config.js';

it('ships unique credential-free HTTPS lists for all six networks, offline', () => {
  const map = parseYaml(readFileSync(bundledRpcPath, 'utf8')) as Record<string, string[]>;
  expect(Object.keys(map).sort()).toEqual(Object.keys(networks).sort());
  for (const name of Object.keys(networks) as NetworkName[]) {
    const urls = validateRpcs(map, name);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.username + parsed.password + parsed.search + parsed.hash).toBe('');
      expect(url).not.toMatch(/YOUR_|\$|\{|\}|<|>|api[_-]?key|token|secret|demo|[a-f0-9]{24,}/i);
    }
  }
});
