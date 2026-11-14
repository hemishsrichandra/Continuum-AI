import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validateDataset } from '../scripts/evaluate.js';

const MINE = [
  { id: 'screen', title: 'Screen flicker', symptoms: 'Screen flickers after startup', environment: 'Model Q firmware 7', solution: 'Open Display settings, select the Standard profile and restart the laptop.', queries: ['My monitor keeps flashing when the notebook boots, Priya Sharma 415 555 0100', 'The panel strobes right after startup'] },
  { id: 'paper', title: 'Paper jam', symptoms: 'Printer paper jam', environment: 'Model P firmware 6', solution: 'Open the rear door and gently pull the jammed sheet toward you.', queries: ['A sheet is trapped in the printer', 'The printer says paper is jammed'] },
];

test('validateDataset accepts well-formed data and rejects malformed data with a clear message', () => {
  assert.equal(validateDataset(MINE).length, 2);
  assert.equal(validateDataset({ cases: MINE }).length, 2);
  assert.throws(() => validateDataset([]), /1 to 100 cases/);
  assert.throws(() => validateDataset('nope'), /1 to 100 cases/);
  assert.throws(() => validateDataset([{ ...MINE[0], id: 'bad id!' }]), /unique and use only/);
  assert.throws(() => validateDataset([MINE[0], { ...MINE[1], id: 'screen' }]), /unique/);
  assert.throws(() => validateDataset([{ ...MINE[0], queries: [] }]), /queries/);
  assert.throws(() => validateDataset([{ ...MINE[0], solution: '' }]), /solution/);
  assert.throws(() => validateDataset([{ ...MINE[0], queries: ['x'.repeat(1001)] }]), /queries/);
  assert.throws(() => validateDataset(Array.from({ length: 101 }, (_, i) => ({ ...MINE[0], id: 'c' + i }))), /1 to 100/);
  assert.equal(validateDataset([{ ...MINE[0], environment: undefined }])[0].environment, '', 'environment is optional');
});

test('evaluating your own dataset runs the real flow and omits raw customer wording from the report', async () => {
  const r = await evaluate({ dataset: MINE });
  assert.equal(r.dataset, 'custom (your data)');
  assert.equal(r.synthetic, false);
  assert.equal(r.counts.positiveQuestions, 4);
  assert.ok(r.counts.correctMemoryOn >= 3, JSON.stringify(r.counts));
  assert.equal(r.counts.incorrectRecommendations, 0);
  assert.equal(r.counts.correctMemoryOff, 0);
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /Priya|415 555|monitor keeps flashing|strobes/, 'no raw customer wording or personal details in the report');
  assert.match(text, /query 1/);
  assert.match(r.embeddingModel, /offline/);
});

test('evaluation queries cannot borrow the stored source title or symptoms as problem evidence', async () => {
  const r = await evaluate({ dataset: [{
    id: 'different-symptom', title: 'Display flicker after startup', symptoms: 'Screen flickers after startup',
    environment: 'Model Q firmware 7', solution: 'Open Display settings and disable Adaptive Refresh, then restart.',
    queries: ['My screen is too dim after startup.'],
  }] });
  assert.equal(r.error, undefined);
  assert.equal(r.counts.positiveQuestions, 1);
  assert.equal(r.counts.correctMemoryOn, 0, 'the different failure must be withheld despite the stored source text');
});

test('embedding evaluation fails loudly without configuration', async () => {
  await assert.rejects(evaluate({ dataset: MINE, embeddings: true, embeddingEnv: {} }), /EMBEDDING_MODEL and EMBEDDING_API_KEY/);
  await assert.rejects(evaluate({ dataset: MINE, embeddings: true, embeddingEnv: { EMBEDDING_MODEL: 'm' } }), /EMBEDDING_API_KEY/);
});

test('embedding evaluation uses the configured model and records it (mock provider)', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push(String(url));
    const input = JSON.parse(options.body).input;
    return Response.json({ data: input.map((x, i) => ({ index: i, embedding: /flick|screen|monitor|panel|display|strob/i.test(x) ? [1, 0, 0] : /jam|paper|sheet|printer/i.test(x) ? [0, 1, 0] : [0, 0, 1] })) });
  });
  const r = await evaluate({ dataset: MINE, embeddings: true, embeddingEnv: { EMBEDDING_MODEL: 'mock-embed', EMBEDDING_API_KEY: 'k', EMBEDDING_BASE_URL: 'https://embeddings.example.test/v1' } });
  assert.equal(r.embeddingModel, 'mock-embed');
  assert.ok(seen.length && seen.every((u) => u === 'https://embeddings.example.test/v1/embeddings'), seen.join(','));
  assert.equal(r.counts.positiveQuestions, 4);
  assert.equal(r.counts.correctMemoryOn, 4);
  assert.equal(r.counts.incorrectRecommendations, 0);
  assert.ok(JSON.stringify(r).includes('mock-embed'), 'the backend is visible in the report');
});
