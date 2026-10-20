import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { statePolicy } from '../src/enrichment.js';
import { SelectionIdentity, type ExtractionManifest } from '../src/persistence.js';
import {
  audit,
  features,
  initialPredictors,
  schemaVersion,
  targets,
  type Row,
} from '../src/rows.js';
import { physicalSchema } from '../src/parquet.js';
import { selection, hash } from './fixtures.js';
export function reportManifest(rows: Row[], complete = true): ExtractionManifest {
  const s = selection();
  return {
    stateEnrichment: { enabled: false, ...statePolicy },
    schemaVersion,
    selection: new SelectionIdentity(s).normalized,
    fingerprint: new SelectionIdentity(s).fingerprint,
    features,
    initialPredictors,
    targets,
    audit,
    physicalSchema,
    outputs: {
      formats: [...s.outputFormats],
      parquetFiles: ['part-9-10.parquet'],
      jsonFile: 'transactions.json',
      pdfFile: 'report.pdf',
    },
    parts: [
      {
        file: 'part-9-10.parquet',
        fromBlock: '9',
        toBlock: '10',
        lastBlockHash: hash(10),
        rows: rows.length,
        sha256: '0'.repeat(64),
      },
    ],
    rowCount: rows.length,
    nextBlock: complete ? '11' : '10',
    lastCommittedBlock: complete ? '10' : '9',
    lastCommittedBlockHash: hash(complete ? 10 : 9),
    complete,
    eventSelectionBias: null,
  };
}
// Inspect actual decoded PDF text operators, independently of the layout helper.
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  return doc
    .getPages()
    .map((page) => {
      const contents = page.node.Contents();
      const streams =
        contents instanceof PDFArray
          ? contents.asArray().map((ref) => doc.context.lookup(ref))
          : [contents];
      return streams
        .filter((stream): stream is PDFRawStream => stream instanceof PDFRawStream)
        .map((stream) => {
          const decoded = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
          return [...decoded.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
            .map((m) => Buffer.from(m[1], 'hex').toString('latin1'))
            .join(' ');
        })
        .join(' ');
    })
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}
