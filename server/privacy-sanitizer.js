// Central privacy boundary for reusable knowledge and for anything sent to an external service.
//
// Pure module (no database or network). It builds on the text rules in privacy.js and adds:
//  * recursive inspection of structured data (applicability conditions, safety restrictions, diagnostic values)
//  * field-aware rules: a value stored under a key such as "email", "phone" or "customer_id" is personal
//    whatever it looks like
//  * detection of tokens, keys and other credential-shaped strings, which are rejected rather than published
//
// Nothing here ever logs or returns a removed value: callers only learn how many items of which kind were removed.
import { scrubPII, containsSecret } from './privacy.js';

const KEY_RULES = [
  ['email', /(^|[_\s-])e-?mail(s)?($|[_\s-])/i],
  ['phone', /(^|[_\s-])(phone|mobile|msisdn|tel|telephone|whatsapp|fax)($|[_\s-])/i],
  ['address', /(^|[_\s-])(address|street|postcode|post_?code|zip(_?code)?|city|pincode)($|[_\s-])/i],
  ['name', /(^|[_\s-])(customer|contact|owner|full|first|last|user|person|employee)[_\s-]?name($|[_\s-])|^name$/i],
  ['customer-id', /(^|[_\s-])(customer|user|account|client|member|ticket)[_\s-]?(id|no|number|ref)($|[_\s-])/i],
  ['serial', /(^|[_\s-])(serial|imei|mac|msisdn|device[_\s-]?id|uuid|guid)($|[_\s-])/i],
  ['credential', /(^|[_\s-])(password|passwd|secret|token|api[_\s-]?key|auth|authorization|credential|bearer|private[_\s-]?key)($|[_\s-])/i],
  ['government-id', /(^|[_\s-])(ssn|aadhaar|aadhar|passport|pan|national[_\s-]?id|tax[_\s-]?id|dob|birth)($|[_\s-])/i],
];
// A key whose name says "this is a diagnostic fact" is never treated as personal just because of its value shape.
const DIAGNOSTIC_KEYS = /^(model|firmware|os|version|android|ios|windows|macos|ubuntu|device|device_type|brand|platform|browser|app_version|build|region)$/i;

const VALUE_RULES = [
  ['customer-id', /\b(?:cust(?:omer)?|user|acct|account|client|member)[-_ #:]*(?:id|no|number)?[-_ #:]*[A-Za-z]{0,3}\d{3,}[A-Za-z0-9-]*\b/gi],
  ['jwt', /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g],
  ['cloud-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[\w-]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[abprs]-[\w-]{10,}\b/g],
  ['bearer', /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi],
  ['mac', /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi],
  ['url-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi],
];
// A long mixed letter/digit string is credential-shaped: reject it instead of guessing what it is.
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;

const MAX_DEPTH = 8;
const MAX_NODES = 600;
const MAX_STRING = 4000;

const kindOfKey = (key) => {
  const k = String(key);
  if (DIAGNOSTIC_KEYS.test(k)) return null;
  for (const [kind, pattern] of KEY_RULES) if (pattern.test(k)) return kind;
  return null;
};

/** True when a field NAME says its value is personal data (such a field is never a compatibility fact). */
export const isPersonalKey = (key) => kindOfKey(key) !== null;

/** Sanitise one string. Returns the cleaned text, redaction counts by kind and whether a credential was found. */
export function sanitizeText(input, { names = [] } = {}) {
  let text = String(input ?? '').slice(0, MAX_STRING);
  const kinds = {};
  const hit = (kind) => (kinds[kind] = (kinds[kind] || 0) + 1);
  const credential = containsSecret(text);
  for (const [kind, pattern] of VALUE_RULES)
    text = text.replace(pattern, () => {
      hit(kind);
      return `[redacted ${kind}]`;
    });
  const opaque = text.match(OPAQUE_TOKEN);
  const scrubbed = scrubPII(text, { names });
  text = scrubbed.text;
  for (const [kind, n] of Object.entries(scrubbed.redactions)) kinds[kind] = (kinds[kind] || 0) + n;
  const hasOpaque = Boolean(opaque?.length);
  const count = Object.values(kinds).reduce((a, b) => a + b, 0);
  return { text, kinds, count, secret: credential || hasOpaque };
}

/**
 * Recursively sanitise arrays/objects. Strings are scrubbed by content, and values under personal-data keys are
 * replaced outright. Bounded in depth, node count and string length so hostile input cannot exhaust the server.
 * `secret` is true when a credential-shaped value was seen: callers must reject or route for review, never publish.
 */
export function sanitizeDeep(value, { names = [] } = {}) {
  const kinds = {};
  let nodes = 0;
  let secret = false;
  let truncated = false;
  const add = (more) => {
    for (const [k, n] of Object.entries(more)) kinds[k] = (kinds[k] || 0) + n;
  };
  const walk = (v, depth, key) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      truncated = true;
      return null;
    }
    if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'number') {
      const kind = key ? kindOfKey(key) : null;
      if (kind && typeof v === 'number') {
        add({ [kind]: 1 });
        return `[redacted ${kind}]`;
      }
      return v;
    }
    if (typeof v === 'string') {
      const kind = key ? kindOfKey(key) : null;
      if (kind && v.trim()) {
        add({ [kind]: 1 });
        if (kind === 'credential') secret = true;
        return `[redacted ${kind}]`;
      }
      const r = sanitizeText(v, { names });
      add(r.kinds);
      if (r.secret) secret = true;
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, key));
    if (typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        // A key can itself carry personal data (for example an email used as a property name).
        const cleanKey = sanitizeText(k).text.slice(0, 100);
        out[cleanKey] = walk(x, depth + 1, k);
      }
      return out;
    }
    return null;
  };
  const clean = walk(value, 0, null);
  const count = Object.values(kinds).reduce((a, b) => a + b, 0);
  return { value: clean, count, kinds, secret, truncated };
}

/** List the kinds of sensitive content present, without returning any of it. Used by validation and tests. */
export function findSensitive(value) {
  const r = sanitizeDeep(value);
  return { kinds: Object.keys(r.kinds), count: r.count, secret: r.secret };
}

/**
 * Text that may leave the server (for example to an embedding provider). Personal data is replaced; a
 * credential-shaped string means nothing is sent at all.
 */
export function forExternalService(text) {
  const r = sanitizeText(text);
  return r.secret ? { ok: false, text: '', reason: 'credential-like content' } : { ok: true, text: r.text, redactions: r.count };
}

/** Throws unless the structure is free of credential-shaped values. Returns the sanitised copy. */
export function sanitizeForPublication(value, { names = [], fault = (m) => new Error(m) } = {}) {
  const r = sanitizeDeep(value, { names });
  if (r.secret) throw fault('Remove credentials, tokens and keys from shared knowledge.');
  if (r.truncated) throw fault('This knowledge entry is too large or too deeply nested to review. Shorten it.');
  return r;
}
