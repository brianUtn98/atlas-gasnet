import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

export interface Store {
  list(): Promise<string[]>;
  read(name: string): Promise<Uint8Array | null>;
  commit(name: string, bytes: Uint8Array): Promise<void>;
}

/** Local persistence adapter: complete and sync bytes before atomic replacement. */
export class FileStore implements Store {
  private constructor(private readonly directory: string) {}

  static async create(directory: string): Promise<FileStore> {
    await mkdir(directory, { recursive: true });
    return new FileStore(directory);
  }

  list(): Promise<string[]> {
    return readdir(this.directory);
  }

  async read(name: string): Promise<Uint8Array | null> {
    try {
      return await readFile(join(this.directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async commit(name: string, bytes: Uint8Array): Promise<void> {
    const file = join(this.directory, name);
    const temporary = `${file}.tmp`;
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);

    // Windows cannot fsync directory handles. File contents are already synced;
    // POSIX also syncs the directory entry for hardware power-loss durability.
    if (process.platform !== 'win32') {
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
}
