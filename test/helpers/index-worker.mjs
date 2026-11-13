// A real, separate OS process that runs the vector-index worker against a shared SQLite file and a real ChromaDB.
// Used by test/multi-process-index.test.js. Configuration comes from the environment:
//   DB_FILE, CHROMA_URL, NAMESPACE, STALL_MS (embedding takes this long: lets the parent kill the process mid-job), AT_OFFSET_MS (clock offset)
import { Store } from '../../server/providers.js'; // imported first, exactly as the app does (database.js and providers.js import each other)
import { createVectorStore } from '../../server/vector-store.js';
import { createEmbeddingService } from '../../server/embedding-service.js';
import { createVectorIndex } from '../../server/vector-index.js';

const store = new Store(process.env.DB_FILE);
const vectors = createVectorStore({ VECTOR_STORE: 'chroma', CHROMA_URL: process.env.CHROMA_URL, VECTOR_NAMESPACE: process.env.NAMESPACE });
const base = createEmbeddingService({});
const stall = Number(process.env.STALL_MS) || 0;
const embedding = { ...base, modelId: base.modelId, embedDocuments: async (texts) => { if (stall) await new Promise((r) => setTimeout(r, stall)); return base.embedDocuments(texts); } };
const index = createVectorIndex(store, { vectors, embedding });
const result = await index.drain({ at: Date.now() + (Number(process.env.AT_OFFSET_MS) || 0), maxBatches: 200 });
console.log('RESULT ' + JSON.stringify(result));
store.close();
process.exit(0);
