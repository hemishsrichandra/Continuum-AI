// Server-side privacy and safety screening for reusable knowledge. Pure module.

const patterns = [
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi],
  ['imei', /\b(?:imei\s*[:#]?\s*)?\d{15}\b/gi],
  ['serial', /\b(?:s\/n|serial(?:\s*(?:no\.?|number))?)\s*[:#]?\s*[a-z0-9-]{4,}\b/gi],
  ['phone', /(?:\+?\d[\d\s().-]{8,}\d)/g],
  ['ip', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['card', /\b(?:\d[ -]?){13,19}\b/g],
  ['name', /\b(?:[Mm]y name is|[Cc]ustomer name:?|[Nn]ame:)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g],
];
const secret = /\b(?:password|passcode|api[_ -]?key|access[_ -]?token|secret|private key)\s*[:=]|\bsk-[\w-]{8,}|\bgsk_[\w-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

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
      if (kind === 'phone' && !/\d{3}.*\d{3}.*\d{3}/.test(m.replace(/\D/g, '').length >= 10 ? m : '')) return m;
      hit(kind);
      return `[redacted ${kind}]`;
    });
  }
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
  [/\b(?:bypass|disable|override)\b[^.]{0,30}\b(?:safety|fuse|thermal|interlock|breaker)\b/i, 'safety bypass'],
  [/\b(?:disable|turn off|uninstall)\b[^.]{0,20}\b(?:antivirus|firewall|security software|defender|edr)\b/i, 'security control disabled'],
  [/\brm\s+-rf\b|\bformat\s+(?:c:|the (?:drive|disk))|\bdd\s+if=|\bmkfs\b|\bdel\s+\/[fsq]/i, 'destructive command'],
  [/\b(?:mains|high[- ]voltage|live wires?|short(?:ing)? (?:the )?(?:pins|terminals|circuit))\b/i, 'electrical hazard'],
  [/\b(?:unofficial|unsigned|third[- ]party)\b[^.]{0,20}\bfirmware\b/i, 'unsigned firmware'],
  [/\b(?:root|jailbreak)\b[^.]{0,20}\b(?:device|phone|tablet)\b/i, 'device rooting'],
  [/<script\b|javascript:|\bon\w+\s*=/i, 'active content'],
];
export function dangerousInstructions(text) {
  const t = String(text || '');
  return dangerous.filter(([p]) => p.test(t)).map(([, why]) => why);
}
