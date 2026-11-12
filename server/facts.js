// Only customer-wide contact/accessibility preferences cross ticket boundaries.
// Technical symptoms, outcomes, and service-specific instructions stay on their ticket.
export const preferenceTicket = 'customer-preferences';
export function extractFacts(message) {
  const text = String(message).trim();
  if (/\b(?:password|api[ _-]?key|access[ _-]?token)\s*[:=]|\bsk-[\w-]+|\bgsk_[\w-]+/i.test(text)) return [];
  const output = [];
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text];
  for (const raw of sentences) {
    const sentence = raw.trim();
    const preferenceQuestion = /^(?:how|what|which|when|where|who|why|do i|did i|have i|is (?:there|my)|are (?:there|my)|(?:can|could|would) you (?:tell|remind|check|show))\b/i.test(sentence);
    // A contact preference is an instruction about HOW to reach the customer: a preference word
    // followed by a contact channel, or an explicit "contact/email/call … me". A technical sentence
    // that merely mentions email ("the email never refreshes") is not a preference.
    const channel = /\b(?:call|phone|email|text|sms|contact|notify|notification|reach|language|speak|screen reader|large text)\b/i;
    const contact =
      !preferenceQuestion &&
      (/\b(?:prefer\w*|please|always|remember|rather|instead|do not|don.t|never)\b[^.!?]*\b(?:call|phone|email|text|sms|contact|notify|notification|reach|language|speak|screen reader|large text)\b/i.test(sentence) ||
        (/\b(?:contact|reach|notify|send|email|call|text) me\b/i.test(sentence) && channel.test(sentence)));
    const category = /screen reader|large text/i.test(sentence)
      ? 'accessibility'
      : /language|speak/i.test(sentence)
        ? 'language'
        : /paid|approv|charge/i.test(sentence)
          ? 'approval'
          : /\b(?:after|before|between)\s+\d|morning|evening|afternoon/i.test(sentence)
            ? 'contact_time'
            : 'contact';
    const ticketSpecific=/\b(?:this|that|the|my)\s+(?:ticket|request|appointment|case|invoice|log|logs)\b|\b(?:SR|IT)-[\w-]+|\b(?:this|that)\s+(?:device|battery|repair)\b/i.test(sentence);
    if (contact) output.push({ kind: 'preference', category, customerWide: !ticketSpecific, text: sentence });
    if (
      /\b(?:did not|didn.t|does not|doesn.t|has not|hasn.t|no longer)\s+(?:work|help|fix|resolve)|\b(?:failed|unsuccessful|no improvement|no difference|not fixed|not resolved|same problem|remains broken|still broken)\b/i.test(
        sentence,
      )
    )
      output.push({ kind: 'failed', text: sentence });
    if (
      /\b(?:deadline|commitment|eta|promised|promise|delivery date)\b/i.test(sentence) &&
      /\b(?:missed|slipped|late|overdue|passed|again|not met)\b/i.test(sentence)
    )
      output.push({ kind: 'missed', text: sentence });
  }
  return output.filter((f, i, all) => all.findIndex((x) => x.kind === f.kind && x.text === f.text) === i);
}
