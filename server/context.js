import { extractFacts } from './facts.js';
import { extractMentions, conditionsFromText, customerFacts, evaluateConditions, stripMentions } from './applicability.js';

// Conservative local language normalization supplements Hindsight's semantic recall.
// Environment compatibility is enforced independently of relevance.
export const resolutionSignature = (r) =>
  [r.environment, r.solution]
    .map((text) =>
      String(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim(),
    )
    .join('\n');
const concepts = [
  ['display', /\b(screen|monitor|display|panel|picture|image|visuals?)\b/g],
  ['flicker', /\b(flicker\w*|flash\w*|blink\w*|strob\w*|shimmer\w*|jitter\w*|jittery|puls(?:e|es|ing)|alternat\w*|unsteady|glitch\w*)\b/g],
  ['startup', /\b(startup|boot\w*|start[ -]?up|power[ -]?on|powers? on|switch(?:ed|es|ing)? on|turn(?:ed|s|ing)? on)\b/g],
  ['laptop', /\b(notebook|laptop)\b/g],
  ['network', /\b(wi[ -]?fi|wireless|internet|network|connectivity|link)\b/g],
  ['offline', /\b(offline|disconnected|unavailable|no connection|not connecting)\b/g],
  ['restart', /\b(reboot\w*|restart\w*)\b/g],
  ['drain', /\b(drain\w*|deplet\w*|discharg\w*|plummet\w*|runs? (?:down|out)|loses? (?:its |their |the |my )?(?:charge|power)|falls? (?:unusually |very |far |too )?(?:fast|quickly|rapidly)|(?:much )?sooner than)\b/g, 'drain battery'],
  ['rapid', /\b(rapid\w*|fast|quick\w*|swift\w*)\b/g],
  ['battery', /\b(battery|charge|charging|energy)\b/g],
  ['disconnect', /\b(disconnect\w*|dropping|drops|cut(?:s|ting)? out|vanish\w*|kicked off|rejoin\w*|intermittent\w*|loses? (?:its |the |my )?(?:connection|link|signal))\b/g],
  ['login', /\b(sign[ -]?in|log[ -]?in|authenticat\w*|credentials?)\b/g],
  ['rejected', /\b(refus\w*|reject\w*|declin\w*|denied|denies|turns? down|not accept\w*|fails?|failed|failing|failure)\b/g],
  // More specific phrases come first so "no sound" is not consumed by the plain "sound" rule.
  ['silent', /\b(silent|muted|no sound|nothing (?:comes out|is heard)|quiet|inaudible|cannot hear|can.t hear|hear no(?:thing)?)\b/g, 'silent audio'],
  ['audio', /\b(audio|sound|speakers?|music|hear|heard|audible)\b/g],
  ['webcam', /\b(webcam|camera)\b/g],
  ['black', /\b(black|blank|empty)\b/g],
  ['storage', /\b(disk|drive|storage)\b/g],
  ['full', /\b(full|out of space|no free space|no (?:available |free )?(?:room|space|capacity)|used up)\b/g],
  ['email', /\b(email|mail|mailbox|inbox)\b/g],
  ['sync', /\b(sync\w*|synchroniz\w*|refresh\w*|stall\w*|stopped updating)\b/g],
  ['application', /\b(app|application|software|program)\b/g],
  ['crash', /\b(crash\w*|closes unexpectedly|unexpectedly (?:closes|quits|exits)|shuts? down|quits?|terminat\w*|closes? (?:by itself|immediately))\b/g],
  ['jam', /\b(jam\w*|stuck|wedged|trapped|caught|clogged)\b/g],
  ['paper', /\b(paper|sheets?|pages?)\b/g],
];
const stop = new Set(
  'the and for with that this please what have from request issue still when after before then how can my your does help device model firmware version laptop a an on is to it not there left much too very every keeps keep been also just really all any some while right even only into out'.split(
    ' ',
  ),
);
function normalize(text) {
  let normalized = String(text).toLowerCase();
  const found = new Set();
  for (const [word, pattern, emit] of concepts) {
    normalized = normalized.replace(pattern, () => {
      for (const part of (emit || word).split(' ')) found.add(part);
      return ' ' + (emit || word) + ' ';
    });
  }
  return { normalized, found };
}
export function tokens(text) {
  const { normalized } = normalize(text);
  return new Set((normalized.match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !stop.has(w)));
}
/** The normalised concepts present in a text (e.g. display, flicker, startup). Stop words excluded. */
export function conceptTokens(text) {
  return new Set([...normalize(text).found].filter((w) => w.length > 2 && !stop.has(w)));
}
export function relevance(query, symptoms) {
  const q = tokens(query),
    s = tokens(symptoms);
  const common = [...s].filter((w) => q.has(w));
  return common.length >= 2 ? common.length / Math.max(2, s.size) : 0;
}
export function constraints(text) {
  // Positive explicit mentions only (negated mentions are not constraints the
  // customer satisfies). Kept for backwards compatibility.
  const result = {};
  for (const m of extractMentions(text).mentions) {
    if (m.negated) continue;
    result[m.key] ||= [];
    if (!result[m.key].includes(m.value)) result[m.key].push(m.value);
  }
  return result;
}
export function compatibility(environment, query, fields = {}) {
  const evaluation = evaluateConditions(conditionsFromText(environment), customerFacts(query, fields));
  const missing = [...evaluation.missing],
    conflicts = [...evaluation.conflicts];
  // Unstructured restrictions must also be explicitly established before steps are exposed.
  const remaining = stripMentions(String(environment).toLowerCase())
    .replace(/\b(?:or|and)\s+(?:later|newer|above|higher|earlier|older|below|lower|up)\b/g, ' ')
    .replace(/\b(?:not|except|excluding|without|other than|at least|up to|minimum|maximum)\b/g, ' ');
  const extra = [...tokens(remaining)].filter(
    (w) => !['all', 'any', 'supported', 'environment', 'environments', 'only', 'later', 'newer', 'earlier', 'older', 'above', 'below'].includes(w),
  );
  const queryWords = tokens(query + ' ' + Object.values(fields || {}).join(' '));
  for (const word of extra) if (!queryWords.has(word)) missing.push(word);
  return { compatible: !missing.length && !conflicts.length, missing, conflicts };
}
export function safeHistory(store, scope, ticketId, enabled, statedPreferences = []) {
  if (!enabled) return [];
  const data = store.data;
  const inactive = data.resolutions.filter(
    (r) =>
      r.retiredAt ||
      (r.reviewRevision || 0) > (r.reviewedRevision || 0) ||
      (r.status && r.status !== 'published'),
  );
  const blocked = new Set(inactive.flatMap((r) => [r.id, r.memoryId]));
  const retiredFacts = data.memories.filter(m => m.scope === scope && m.invalidatedAt);
  const retiredIds = new Set(retiredFacts.map(m => m.id));
  return (
    data.conversations
      .filter((c) => c.scope === scope && c.ticketId === ticketId && !c.archivedAt)
      .filter(c => !(c.response.evidence || []).some(e => retiredIds.has(e.id)))
      .filter(c => !retiredFacts.some(m => m.text &&
        (c.message.includes(m.text) || c.response.reply?.includes(m.text))))
      .filter(c => !statedPreferences.some(p =>
        extractFacts(c.message).some(f => f.kind === 'preference' && f.category === p.category) ||
        (c.response.evidence || []).some(e => e.kind === 'preference')))
      .filter(
        (c) =>
          !c.response.resolutionId &&
          !blocked.has(c.response.resolutionId) &&
          !(c.response.evidence || []).some(
            (e) => e.kind === 'verified_resolution' || blocked.has(e.id) || blocked.has(e.resolutionId),
          ),
      )
      // Legacy assistant messages lack reliable provenance. Never recycle stale solution text.
      .filter((c) => !inactive.some((r) => r.solution && c.response.reply?.includes(r.solution)))
      .slice(-4)
      .map((c) => ({ question: c.message, answer: c.response.reply }))
  );
}

export function modelTicket(ticket) {
  const { id, title, issue, status, eta, assignedTo, priority } = ticket;
  // Case history can contain failed/retired procedures. It belongs to the human
  // handoff, not an unfiltered model prompt.
  return { id, title, issue, status, eta, assignedTo, priority };
}
