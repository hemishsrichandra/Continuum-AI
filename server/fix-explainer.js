// "Why this fix fits your problem": one plain sentence shown next to a suggested fix.
//
// GROUNDED BY CONSTRUCTION. The sentence is only ever a description of text that is already stored with the fix
// (title, symptoms, reviewed steps) and the customer's own words. It is not a source of instructions:
//   * the model is asked for one short sentence and told to use nothing but the supplied text
//   * the answer is rejected unless it is a single short sentence, contains no number, link, quoted term or
//     command-like token that is absent from the supplied text, and is mostly made of words from that text
//   * any rejection, timeout, missing key or provider error falls back to a deterministic template
//   * personal data is removed from the customer's words first, and credential-like text is never sent
// The reviewed steps themselves are always shown to the customer unchanged; this sentence never replaces them.
import { createHash } from 'node:crypto';
import { modelFetch } from './model.js';
import { containsSecret, scrubPII } from './privacy.js';
import { tokens } from './context.js';

const MAX_CHARS = 220;
const MAX_WORDS = 34;
const CACHE_MAX = 300;
const CACHE_TTL = 30 * 60 * 1000;
// Words that may appear in an explanation without being in the source: connectives and generic framing.
const FRAMING = new Set((
  'this that these those fix fits fit your you problem issue because since describes describe describing matches match matching ' +
  'similar same steps step address addresses addressing targets target helps help which when where while with from for the and ' +
  'are was were has have had can may will also both what into onto than then they them their its not does did about after before ' +
  'during over under using use used customer customers reported reviewed company applies apply applicable here there relevant ' +
  'symptom symptoms like such cause causes caused covers cover stored store saved'
).split(/\s+/));

const words = (s) => String(s).toLowerCase().match(/[a-z0-9]+(?:[.\-'][a-z0-9]+)*/g) || [];
const stem = (w) => w.replace(/(?:ing|ed|es|s)$/i, '');

/** Deterministic sentence built only from stored fields. Always available, never invents anything. */
export function templateWhy({ title = '', reasons = [] } = {}) {
  const fits = (reasons || []).filter(Boolean).slice(0, 2);
  const base = title ? `This fix, “${String(title).trim()}”, matches the problem you described` : 'This fix matches the problem you described';
  return fits.length ? `${base} and fits ${fits.join(' and ')}.` : `${base}.`;
}

/**
 * Check a candidate sentence against the text it must be grounded in.
 * @returns {{ok: true} | {ok: false, why: string}}
 */
export function checkGrounded(sentence, sourceText) {
  const s = String(sentence ?? '').trim();
  if (!s) return { ok: false, why: 'empty' };
  if (s.length > MAX_CHARS) return { ok: false, why: 'too long' };
  if ((s.match(/[.!?](?:\s|$)/g) || []).length > 1 || /\n/.test(s)) return { ok: false, why: 'more than one sentence' };
  if (words(s).length > MAX_WORDS) return { ok: false, why: 'too many words' };
  if (/https?:\/\/|www\.|`|<[^>]+>|\$\(|\b(?:sudo|rm|del|format|regedit|powershell|cmd\.exe)\b/i.test(s)) return { ok: false, why: 'link or command' };
  if (containsSecret(s)) return { ok: false, why: 'secret-like text' };
  const source = String(sourceText ?? '').toLowerCase();
  const sourceWords = new Set(words(source).flatMap((w) => [w, stem(w)]));
  // Every number (versions, sizes, times) must already be in the source.
  for (const n of s.match(/\d+(?:\.\d+)*/g) || []) if (!source.includes(n)) return { ok: false, why: 'number not in source' };
  // Anything quoted must be in the source verbatim.
  for (const q of s.match(/[“"']([^”"']{2,80})[”"']/g) || []) if (!source.includes(q.slice(1, -1).toLowerCase())) return { ok: false, why: 'quote not in source' };
  const content = words(s).filter((w) => w.length >= 4 && !FRAMING.has(w));
  if (!content.length) return { ok: true };
  const unknown = content.filter((w) => !sourceWords.has(w) && !sourceWords.has(stem(w)));
  if (unknown.length / content.length > 0.34) return { ok: false, why: 'words not in source: ' + unknown.slice(0, 3).join(', ') };
  return { ok: true };
}

export function createFixExplainer(config = {}, { fetchImpl = null, now = Date.now } = {}) {
  const enabled = Boolean(config.OPENAI_API_KEY) && String(config.FIX_EXPLANATIONS || 'model').toLowerCase() !== 'off';
  const timeoutMs = Number(config.FIX_EXPLANATION_TIMEOUT_MS) > 0 ? Number(config.FIX_EXPLANATION_TIMEOUT_MS) : 2500;
  const cache = new Map();
  const stats = { model: 0, template: 0, rejected: 0, errors: 0, cacheHits: 0 };

  async function ask({ title, symptoms, steps, customerText }) {
    const url = (config.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
    const call = fetchImpl || ((u, o) => modelFetch(u, o));
    const system =
      'You write ONE short sentence (at most 30 words) telling a customer why a stored support fix fits their problem. ' +
      'Use ONLY facts in the STORED FIX and CUSTOMER WORDS below. Never add steps, settings, numbers, links, commands, ' +
      'causes or promises that are not written there. Do not repeat the steps. Reply with the sentence only.';
    const user = `STORED FIX title: ${title}\nSTORED FIX symptoms: ${symptoms}\nSTORED FIX steps: ${steps}\nCUSTOMER WORDS: ${customerText || '(none)'}`;
    const response = await Promise.race([
      call(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.OPENAI_API_KEY },
        body: JSON.stringify({ model: config.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0, max_tokens: 90, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    if (!response.ok) throw new Error('provider status ' + response.status);
    const body = await response.json();
    return String(body?.choices?.[0]?.message?.content ?? '').trim().replace(/^["“]|["”]$/g, '');
  }

  /**
   * @param fix { id, version, title, symptoms, steps: string[] | string, reasons?: string[] }
   * @param customerText the customer's own description (will be scrubbed)
   * @returns {{ text: string, method: 'model'|'template' }}
   */
  async function explain(fix, customerText = '') {
    const fallback = () => { stats.template++; return { text: templateWhy({ title: fix.title, reasons: fix.reasons }), method: 'template' }; };
    if (!enabled) return fallback();
    const steps = Array.isArray(fix.steps) ? fix.steps.join(' ') : String(fix.steps || '');
    const raw = String(customerText || '');
    const customer = containsSecret(raw) ? '' : scrubPII(raw, { names: [] }).text.slice(0, 600);
    if (containsSecret([fix.title, fix.symptoms, steps].join('\n'))) return fallback();
    const key = createHash('sha256').update([fix.id, fix.version, customer].join('\u0000')).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.at > now() - CACHE_TTL) { stats.cacheHits++; return hit.value; }
    try {
      const sentence = await ask({ title: fix.title, symptoms: fix.symptoms || '', steps, customerText: customer });
      const verdict = checkGrounded(sentence, [fix.title, fix.symptoms, steps, customer].join('\n'));
      if (!verdict.ok) { stats.rejected++; return fallback(); }
      stats.model++;
      const value = { text: /[.!?]$/.test(sentence) ? sentence : sentence + '.', method: 'model' };
      cache.set(key, { at: now(), value });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return value;
    } catch {
      stats.errors++;
      return fallback();
    }
  }
  return { explain, enabled, stats: () => ({ ...stats }) };
}
