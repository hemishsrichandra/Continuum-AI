// Server-side privacy and safety screening for reusable knowledge. Pure module.

const patterns = [
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi],
  ['imei', /\b(?:imei\s*[:#]?\s*)?\d{15}\b/gi],
  ['serial', /\b(?:s\/n|serial(?:\s*(?:no\.?|number))?)\s*[:#]?\s*[a-z0-9-]{4,}\b/gi],
  // Any run of 10–15 digits with common separators (spaces, dots, dashes, brackets), including
  // grouped national formats such as +91 98765 43210. Short dotted versions (4.2, 13.1.2) are untouched.
  ['phone', /(?:\+\s?\d[\d\s().-]{8,}\d|\(?\d{2,5}\)?[\s.-]?\d{3,5}[\s.-]?\d{3,5}(?:[\s.-]?\d{1,4})?)/g],
  ['address', /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Nagar|Colony)\b\.?(?:,\s*[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)?/g],
  ['id-number', /\b\d{4}\s\d{4}\s\d{4}\b/g],
  ['ip', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['card', /\b(?:\d[ -]?){13,19}\b/g],
  ['name', /\b(?:[Mm]y name is|[Cc]ustomer name:?|[Nn]ame:)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|\b(?:Mr|Mrs|Ms|Miss|Dr|Shri|Smt)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g],
];
const secret = /\b(?:password|passcode|api[_ -]?key|access[_ -]?token|secret|private key)\s*[:=]|\bsk-[\w-]{8,}|\bgsk_[\w-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

const CUE_NAME = /\b((?:[Aa]sk|[Cc]ontact|[Cc]all|[Ee]mail|[Ss]peak to|[Tt]alk to|[Tt]hanks|[Tt]hank you|[Rr]egards|[Dd]ear|[Hh]i|[Hh]ello|[Aa]ttn|[Cc]c|[Ff]rom|[Ss]igned)[:,]?)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b/g;
// Capitalised words that follow those cues but are not people.
const NOT_NAMES = new Set(['support', 'settings', 'windows', 'microsoft', 'apple', 'google', 'android', 'admin', 'administrator', 'team', 'desk', 'helpdesk', 'service', 'services', 'manager', 'display', 'network', 'help', 'model', 'customer', 'specialist', 'technician', 'vendor', 'sales', 'billing', 'dell', 'lenovo', 'cisco', 'samsung', 'sony', 'huawei', 'asus', 'acer', 'linux', 'ubuntu', 'chrome', 'firefox', 'edge', 'outlook', 'office', 'teams', 'zoom', 'slack', 'wifi', 'bluetooth', 'usb', 'the', 'our', 'your', 'this', 'that', 'these', 'those', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'again', 'later', 'now', 'today', 'tomorrow', 'please', 'everyone', 'all', 'anyone', 'someone', 'security', 'engineering', 'operations', 'finance', 'legal', 'hr', 'reception', 'warranty', 'repair', 'repairs', 'store', 'shop', 'center', 'centre', 'adaptive', 'automatic', 'auto', 'default', 'standard', 'balanced', 'fixed', 'dynamic', 'custom', 'normal', 'performance']);
export const containsSecret = (text) => secret.test(String(text || ''));

/**
 * Redact personal data. `names` are known private names (e.g. the customer's) that
 * must never reach shared knowledge. Returns the scrubbed text and a redaction count.
 */
export function scrubPII(text, { names = [] } = {}) {
  let out = String(text ?? '');
  const redactions = {};
  const hit = (kind) => (redactions[kind] = (redactions[kind] || 0) + 1);
  for (const [kind, pattern] of patterns) {
    out = out.replace(pattern, (m) => {
      // Short dotted version numbers such as "4.2" or "13.1.2" are not IPs or phones.
      if (kind === 'phone') {
        const digits = m.replace(/\D/g, '').length;
        // Too short or too long, or an IPv4 address (handled by its own rule): not a phone number.
        if (digits < 10 || digits > 15 || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(m.trim())) return m;
      }
      hit(kind);
      return `[redacted ${kind}]`;
    });
  }
  // Names that follow a cue word ("ask Priya Sharma", "thanks, Raj", "contact Dr. Rao") are redacted even when
  // the name is not known in advance. Common product, role and company words are never treated as names.
  out = out.replace(CUE_NAME, (match, cue, name) => {
    const words = name.split(/\s+/);
    const kept = [];
    while (words.length && NOT_NAMES.has(words[words.length - 1].toLowerCase())) kept.unshift(words.pop());
    if (!words.length || NOT_NAMES.has(words[0].toLowerCase())) return match;
    hit('name');
    return `${cue} [redacted name]${kept.length ? ' ' + kept.join(' ') : ''}`;
  });
  for (const name of names.filter((n) => typeof n === 'string' && n.trim().length >= 3)) {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('\\b' + escaped + '\\b', 'gi'), () => {
      hit('name');
      return '[redacted name]';
    });
  }
  const count = Object.values(redactions).reduce((a, b) => a + b, 0);
  return { text: out, redactions, count };
}

export function containsPII(text, options) {
  return scrubPII(text, options).count > 0;
}

// Instructions that must never be auto-published or silently imported as active.
const dangerous = [
  [/\b(?:open|pry|puncture|pierce|disassemble|remove)\b[^.]{0,30}\bbattery\b/i, 'battery disassembly'],
  [/\b(?:pierce|puncture|cut|stab|lance)\b[^.]{0,35}\b(?:lithium|pouch|cell(?!\s*(?:phone|service|signal|tower|network))|battery)\b/i, 'battery puncture'],
  [/\b(?:solder|weld)\b[^.]{0,30}\b(?:battery|cell|terminal)\b/i, 'battery soldering'],
  [/\b(?:bypass|disable|override)\b[^.]{0,30}\b(?:safety|fuse|thermal|interlock|breaker)\b/i, 'safety bypass'],
  [/\b(?:disable|turn off|uninstall)\b[^.]{0,20}\b(?:antivirus|firewall|security software|defender|edr)\b/i, 'security control disabled'],
  [/\brm\s+-rf\b|\bformat\s+(?:c:|the (?:drive|disk))|\bdd\s+if=|\bmkfs\b|\bdel\s+\/[fsq]/i, 'destructive command'],
  [/\b(?:mains|high[- ]voltage|live wires?|short(?:ing)? (?:the )?(?:pins|terminals|circuit))\b/i, 'electrical hazard'],
  [/\b(?:unofficial|unsigned|third[- ]party)\b[^.]{0,20}\bfirmware\b/i, 'unsigned firmware'],
  [/\b(?:root|jailbreak)\b[^.]{0,20}\b(?:device|phone|tablet)\b/i, 'device rooting'],
  [/<script\b|javascript:|\bon\w+\s*=/i, 'active content'],
  [/\b(?:ignore|disregard|forget)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.]{0,30}\b(?:instructions?|rules|prompts?)\b|\bsystem prompt\b|\byou are now\b|\b(?:reveal|print|show)\b[^.]{0,20}\b(?:your|the) (?:instructions|prompt|secrets?)\b/i, 'instruction injection'],
];
/**
 * Undo simple obfuscation before inspecting: single letters joined by punctuation ("p.r.y", "b-a-t-t-e-r-y", "s*o*l*d*e*r") are read as the word they
 * spell, and zero-width and soft-hyphen characters are dropped. The original text is inspected as well, so nothing that matched before stops matching.
 */
export function deobfuscate(text) {
  return String(text || '')
    .replace(/[​-‍⁠­﻿]/g, '')
    .replace(/(?<![A-Za-z])(?:[A-Za-z][.\-_*|/·•]){2,}[A-Za-z](?![A-Za-z])/g, (run) => run.replace(/[^A-Za-z]/g, ''));
}
export function dangerousInstructions(text) {
  const raw = String(text || '');
  const plain = deobfuscate(raw);
  return dangerous.filter(([p]) => p.test(raw) || (plain !== raw && p.test(plain))).map(([, why]) => why);
}
