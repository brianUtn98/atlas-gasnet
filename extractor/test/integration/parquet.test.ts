import { expect, it } from 'vitest';
import { parquetReadObjects, parquetMetadataAsync } from 'hyparquet';
import { ParquetCodec, physicalSchema } from '../../src/parquet.js';
import { RowNormalizer } from '../../src/rows.js';
import { block, receipt, tx, hash } from '../fixtures.js';
it('round-trips exact values, nulls, identities, reverts and a zero-match schema', async () => {
  const t = tx(9n, { value: 900719925474099312345n, nonce: 9007199254740993n });
  const legacy = new RowNormalizer('ETHEREUM').normalize({
    transaction: t,
    block: block(),
    receipt: receipt(t, { status: 'reverted' }),
  });
  const dynamicTx = tx(9n, {
    hash: hash(901),
    transactionIndex: 1,
    type: 'eip1559',
    maxFeePerGas: 9007199254740995n,
    maxPriorityFeePerGas: 10n,
  });
  const dynamic = new RowNormalizer('ETHEREUM').normalize({
    transaction: dynamicTx,
    block: block(9n, [t, dynamicTx]),
    receipt: receipt(dynamicTx),
  });
  for (const rows of [[legacy, dynamic], []]) {
    const bytes = new ParquetCodec().encode(rows).bytes;
    const file = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    expect(await parquetReadObjects({ file })).toEqual(rows);
    const metadata = await parquetMetadataAsync(file);
    expect(Number(metadata.num_rows)).toBe(rows.length);
    expect(metadata.schema.slice(1).map((c) => c.name)).toEqual(physicalSchema.map((c) => c.name));
  }
});
