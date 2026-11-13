// Operator commands for the semantic search index (SQLite stays the source of truth; the index can always be rebuilt).
//
//   npm run index -- health            show database / index / embedding status
//   npm run index -- drain             index whatever is waiting
//   npm run index -- reindex           re-embed everything (use after changing EMBEDDING_MODEL or losing the index)
//   npm run index -- reindex <company> the same, for one company
//   npm run index -- reconcile         remove vectors that should not exist and queue anything missing
//   npm run index -- retry-failed      put failed indexing jobs back in the queue
import { existsSync } from 'node:fs';
import { createHandler } from '../server/app.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const [command = 'health', target] = process.argv.slice(2);
const handler = createHandler({ file: process.env.DATABASE_FILE || new URL('../data/demo.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), config: { ...process.env, ENABLE_OUTBOX_WORKER: 'false' } });
const { vectorIndex, vectors, embedding } = handler;
const show = (value) => console.log(JSON.stringify(value, null, 2));
try {
  if (!vectors.enabled && command !== 'health') {
    console.error('The vector index is not configured. Set VECTOR_STORE=chroma and CHROMA_URL in .env first.');
    process.exitCode = 1;
  } else if (command === 'health') show(await vectorIndex.health({ probe: true }));
  else if (command === 'drain') show(await vectorIndex.drain({ maxBatches: 1000 }));
  else if (command === 'reindex') {
    show({ queued: vectorIndex.reindexKnowledge({ companyId: target || null }), model: embedding.modelId() });
    show(await vectorIndex.drain({ maxBatches: 1000 }));
  } else if (command === 'reconcile') {
    show(await vectorIndex.reconcileVectorIndex());
    show(await vectorIndex.drain({ maxBatches: 1000 }));
  } else if (command === 'retry-failed') {
    show({ requeued: vectorIndex.retryFailed() });
    show(await vectorIndex.drain({ maxBatches: 1000 }));
  } else {
    console.error('Unknown command. Use: health | drain | reindex [company] | reconcile | retry-failed');
    process.exitCode = 1;
  }
} finally {
  handler.close();
}
