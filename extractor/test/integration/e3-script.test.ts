import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it.skipIf(process.platform !== 'win32')(
  'PowerShell continues all remaining stages after a stage with pending errors',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-e3-partial-'));
    try {
      await mkdir(join(dir, 'scripts'));
      await copyFile(
        new URL('../../../scripts/run-e3-extraction.ps1', import.meta.url),
        join(dir, 'scripts/run.ps1'),
      );
      for (const stage of ['train', 'validation', 'test', 'unseen-contract']) {
        const output = join(dir, 'data/extractions/e3-v1', stage);
        await mkdir(output, { recursive: true });
        await writeFile(
          join(output, 'manifest.json'),
          JSON.stringify({
            complete: stage !== 'train',
            scanComplete: true,
            errorCount: stage === 'train' ? 1 : 0,
            rowCount: 7,
          }),
        );
      }
      await writeFile(
        join(dir, 'npm.cmd'),
        '@echo off\r\necho called >> "%~dp0calls.txt"\r\nexit /b 0\r\n',
      );
      const result = await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(dir, 'scripts/run.ps1'),
          '-Phase',
          'Full',
        ],
        { cwd: dir, env: { ...process.env, PATH: `${dir};${process.env.PATH}` } },
      );
      expect(result.stdout).toContain('pending errors');
      expect(result.stdout).toContain('Completed unseen-contract');
      expect((await readFile(join(dir, 'calls.txt'), 'utf8')).trim().split(/\r?\n/)).toHaveLength(
        4,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  20000,
);

it.skipIf(process.platform !== 'win32').each([1, 2])(
  'PowerShell logs native stderr and handles exit %i correctly',
  async (exitCode) => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-e3-script-'));
    try {
      await mkdir(join(dir, 'scripts'));
      await mkdir(join(dir, 'data/extractions/e3-v1/unseen-contract'), { recursive: true });
      await copyFile(
        new URL('../../../scripts/run-e3-extraction.ps1', import.meta.url),
        join(dir, 'scripts/run.ps1'),
      );
      await writeFile(
        join(dir, 'data/extractions/e3-v1/unseen-contract/manifest.json'),
        JSON.stringify({ complete: true, rowCount: 7 }),
      );
      await writeFile(
        join(dir, 'npm.cmd'),
        `@echo off\r\nif exist "%~dp0failed-once" exit /b 0\r\necho failed > "%~dp0failed-once"\r\necho simulated RPC stderr 1>&2\r\nexit /b ${exitCode}\r\n`,
      );
      const call = execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(dir, 'scripts/run.ps1'),
          '-Phase',
          'Full',
          '-Stages',
          'unseen-contract',
          '-RetryDelaySeconds',
          '0',
        ],
        { cwd: dir, env: { ...process.env, PATH: `${dir};${process.env.PATH}` } },
      );
      if (exitCode === 2) {
        const result = await call;
        expect(result.stdout).toContain('RPC recovery:');
        expect(result.stdout).toContain('Completed unseen-contract: 7 rows');
      } else await expect(call).rejects.toThrow('exit 1');
      const logs = await readdir(join(dir, 'models/extraction-logs'));
      const bytes = await readFile(join(dir, 'models/extraction-logs', logs[0]));
      const log = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8');
      expect(log).toContain('simulated RPC stderr');
      expect(log.includes('RPC recovery:')).toBe(exitCode === 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  20000,
);
