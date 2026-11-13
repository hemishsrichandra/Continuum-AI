// A small in-process stand-in for the ChromaDB client, used to test the vector pipeline deterministically
// (indexing, outage recovery, isolation) without a server. It is a TEST DOUBLE: a separate test
// (test/chroma-live.test.js) exercises the real ChromaDB server when one is reachable.
const cosineDistance = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? 1 - dot / Math.sqrt(na * nb) : 1;
};
const matches = (meta, where) => {
  if (!where) return true;
  if (where.$and) return where.$and.every((w) => matches(meta, w));
  return Object.entries(where).every(([k, v]) => meta[k] === v);
};

export function createFakeChroma() {
  const state = { collections: new Map(), down: false, ignoreWhere: false, upserts: 0, deletes: 0, queries: 0 };
  const guard = () => {
    if (state.down) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { transient: true });
  };
  const make = (name, metadata) => {
    const rows = new Map();
    return {
      name,
      metadata,
      rows,
      async upsert({ ids, embeddings, metadatas }) {
        guard();
        state.upserts++;
        ids.forEach((id, i) => rows.set(id, { vector: embeddings[i], meta: metadatas[i] }));
      },
      async query({ queryEmbeddings, nResults, where, ids }) {
        guard();
        state.queries++;
        const found = [...rows.entries()]
          .filter(([id, r]) => (state.ignoreWhere || matches(r.meta, where)) && (!ids || ids.includes(id)))
          .map(([id, r]) => ({ id, d: cosineDistance(queryEmbeddings[0], r.vector) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, nResults);
        return { ids: [found.map((f) => f.id)], distances: [found.map((f) => f.d)] };
      },
      async get({ ids, limit, offset = 0 } = {}) {
        guard();
        const all = [...rows.keys()];
        return { ids: ids ? all.filter((id) => ids.includes(id)) : all.slice(offset, limit ? offset + limit : undefined) };
      },
      async delete({ ids }) {
        guard();
        state.deletes++;
        ids.forEach((id) => rows.delete(id));
      },
      async count() {
        guard();
        return rows.size;
      },
    };
  };
  const client = {
    async heartbeat() { guard(); return Date.now(); },
    async getOrCreateCollection({ name, metadata }) {
      guard();
      if (!state.collections.has(name)) state.collections.set(name, make(name, metadata));
      return state.collections.get(name);
    },
  };
  return { client, state, ids: (name) => [...(state.collections.get(name)?.rows.keys() || [])], collection: () => [...state.collections.values()][0] };
}
