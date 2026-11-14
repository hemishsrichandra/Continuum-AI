// Pre-retrieval query normalization ("de-noising"). Deterministic rules always run; an approved model can be plugged in and is
// used only when it keeps every device/version fact and negation the customer stated. Anything wrong, slow or missing falls back to
// the rules. The raw message is never altered or stored here: this only builds the text used to SEARCH.
import { scrubPII } from './privacy.js';
import { extractMentions } from './applicability.js';

// Canonical technical symptoms and the component they point to. Patterns are checked on the sanitized message.
const SYMPTOMS = [
  // A camera's unavailable state is often written as "isnt working" rather than "not turning on".
  // Keep this component-specific: a freezing camera or a computer with no power is a different failure.
  [/\b(?:webcam|camera)\s+(?:(?:is|does|will)\s+not|isn['’]?t|doesn['’]?t|won['’]?t|can['’]?t|cannot|not)\s+(?:work(?:ing)?|turn(?:ing)?\s+on|start(?:ing)?|open(?:ing)?|activat(?:e|ing))\b/i, 'webcam not turning on', 'webcam'],
  [/\b(?:won'?t|will not|wont|doesn'?t|does not|not|never|fails? to|unable to|can'?t|cannot)\s+(?:\w+\s+){0,2}(?:wake|waking|resume)\b|\bwon'?t wake\b|\bstuck (?:in|on) sleep\b/i, 'fails to wake from sleep', 'power'],
  [/\b(?:black|blank|dark)\s+screen\b|\bscreen (?:is|stays|remains|went|goes)\s+(?:black|blank|dark)\b|\bdisplay (?:is|stays|remains)\s+(?:black|blank)\b|\bnothing on (?:the )?(?:screen|display)\b/i, 'screen remains black', 'display'],
  [/\bflicker\w*|\bflash(?:es|ing)\s+(?:screen|display)\b|\bscreen (?:keeps )?flash\w*\b|\bblink\w*/i, 'screen flickers', 'display'],
  [/\b(?:won'?t|will not|wont|doesn'?t|does not|not)\s+(?:turn|power|switch)\s*(?:on|up)\b|\b(?:completely )?dead\b|\bno power\b/i, 'does not power on or respond', 'power'],
  [/\bbattery\b[^.!?]{0,40}\b(?:drain|dies|die|dying|empty|low|fast|quickly)\w*|\b(?:drain|dies|dying)\w*[^.!?]{0,30}\bbattery\b/i, 'battery drains quickly', 'battery'],
  [/\b(?:won'?t|will not|doesn'?t|does not|not)\s+charg\w*|\bcharging (?:stopped|problem|issue)\b/i, 'does not charge', 'battery'],
  [/\b(?:wi-?fi|wireless|internet|network)\b[^.!?]{0,40}\b(?:drop\w*|disconnect\w*|down|keeps? (?:dropping|disconnecting)|offline|not working)\b|\boffline\b/i, 'network connection drops or is offline', 'network'],
  [/\b(?:no|crackl\w*|distort\w*|muffled)\s+(?:sound|audio)\b|\b(?:sound|audio|speakers?)\b[^.!?]{0,30}\b(?:not working|crackl\w*|distort\w*)\b/i, 'audio problem', 'audio'],
  [/\b(?:very )?slow\b|\blag(?:s|gy|ging)?\b|\bfreez\w*|\bhang(?:s|ing)?\b/i, 'device is slow or freezes', 'performance'],
  [/\boverheat\w*|\b(?:very |too |gets? )hot\b/i, 'device overheats', 'thermal'],
];
const URGENCY = /\b(?:in\s+\d+\s*(?:min(?:ute)?s?|hours?|hrs?)|meeting|deadline|presentation|exam|interview|urgent(?:ly)?|asap|right now|immediately|emergency)\b/i;
// Emphatic or insulting words carry no technical meaning. Negations are deliberately NOT here.
const URGENCY_CLAUSE = /\b(?:i(?:'m| am| have| got)\s+(?:an?\s+)?)?(?:meeting|deadline|presentation|exam|interview)(?:\s+(?:in|within|at|by)\s+\d+\s*\w+)?\s*[,.]?/gi;
const NOISE = /\b(?:stupid|damn|damned|dumb|useless|garbage|crap|freaking|freakin|bloody|ridiculous|terrible|awful|hate|annoying|piece of junk|piece of crap)\b/gi;
const FILLER = /\b(?:please|pls|help me|help|hi|hello|hey|thanks|thank you|ugh|omg|lol|just|really|very|so|literally)\b/gi;

const clean = (s) => s.replace(NOISE, ' ').replace(FILLER, ' ').replace(/[!?]{2,}/g, ' ').replace(/\s+/g, ' ').trim();
const facts = (text) => extractMentions(text).mentions.map((m) => `${m.negated ? '!' : ''}${m.key}:${m.value}`).sort();

/** Rules only. Always safe, always fast. */
export function normalizeWithRules(sanitized) {
  const found = SYMPTOMS.filter(([re]) => re.test(sanitized));
  const symptoms = [...new Set(found.map(([, s]) => s))];
  if (!symptoms.length && /brick(?:ed)?/i.test(sanitized)) symptoms.push('does not respond');
  const components = [...new Set(found.map(([, , c]) => c))];
  const urgency = URGENCY.test(sanitized) ? 'time-sensitive' : 'normal';
  const assumptions = [];
  if (/\bbrick(?:ed)?\b/i.test(sanitized)) assumptions.push('"brick" is read as "does not respond"; not confirmed as hardware failure');
  if (urgency === 'time-sensitive') assumptions.push('urgency is the customer\'s own statement; it does not change what is safe to suggest');
  // Keep the customer's own words (minus emotion and urgency chatter) so negations, models and versions survive untouched.
  const kept = clean(sanitized.replace(URGENCY_CLAUSE, ' ').replace(new RegExp(URGENCY.source, 'gi'), ' ')).replace(/\s+([,.])/g, '$1').replace(/^[,.\s]+|[,\s]+$/g, '');
  return { symptoms, components, urgency, assumptions, kept, retrievalText: [symptoms.join('. '), kept].filter(Boolean).join('. ') || sanitized };
}

/**
 * @param provider optional async (sanitizedText) => { symptoms?: string[], retrievalText?: string }. Called with sanitized text only.
 */
export async function normalizeQuery(message, { provider = null, timeoutMs = 1500 } = {}) {
  const t0 = performance.now();
  const raw = String(message ?? '');
  const sanitized = scrubPII(raw, { names: [] }).text; // nothing identifying ever reaches a provider
  const rules = normalizeWithRules(sanitized);
  const done = (method, extra = {}) => ({ ...rules, ...extra, method, raw, sanitized, ms: Math.round((performance.now() - t0) * 100) / 100 });
  if (!provider || sanitized.trim().length < 12) return done('rules');
  try {
    const out = await Promise.race([provider(sanitized), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))]);
    const text = typeof out?.retrievalText === 'string' ? out.retrievalText.trim() : '';
    if (!text || text.length > 1000) return done('rules', { fallbackReason: 'empty or oversized model answer' });
    // A model may never change what the customer said about their device: every stated fact (and negation) must survive, and nothing
    // new may be invented.
    const before = facts(sanitized), after = facts(text);
    if (before.join('|') !== after.join('|')) return done('rules', { fallbackReason: 'the model changed or invented a device fact' });
    return done('model', { retrievalText: text, symptoms: Array.isArray(out.symptoms) ? out.symptoms.slice(0, 5) : rules.symptoms });
  } catch (e) {
    return done('rules', { fallbackReason: e.message === 'timeout' ? 'the model did not answer in time' : 'the model failed' });
  }
}
