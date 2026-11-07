import { tokens } from './context.js';

const generic = new Set(['request', 'ticket', 'case', 'issue', 'service', 'support', 'test', 'testing']);
const words = (text) => new Set([...tokens(text)].filter((w) => !generic.has(w)));

// Match only an account's own request list. A reference is navigation, never
// authorization to change a different record or retain its facts on this ticket.
export function requestReference(message, tickets, currentId) {
  const text = message.replace(/[\u2010-\u2015\u2011]/g, '-');
  if (/\b(?:do not|don't|never)\s+(?:switch|open|select)\b/i.test(text)) return null;
  if (/\b(?:add|leave|attach|record)\s+(?:a\s+)?(?:note|comment|instruction)\b/i.test(text) ||
      /\b(?:create|raise|file|open)\s+(?:a\s+)?(?:new\s+)?(?:request|ticket|case)\b/i.test(text)) return null;
  const ids = text.match(/\b(?:SR|IT)-[a-z0-9]+(?:-[a-z0-9]+)*\b/gi) || [];
  let matches;
  if (ids.length) {
    const wanted = new Set(ids.map((id) => id.toUpperCase()));
    matches = tickets.filter((t) => wanted.has(t.id.toUpperCase()));
    if (matches.length !== wanted.size) return {
      question: 'I cannot identify that request in your personal workspace. Select the request you mean from your request list.',
      choices: [],
    };
  } else {
    if (!/\b(?:request|ticket|case)\b/i.test(text) ||
        !/\b(?:what about|how about|status|check|switch|select|open|regarding|about|update)\b/i.test(text)) return null;
    const query = words(text);
    matches = tickets.filter((t) => {
      const title = words(t.title);
      return title.size > 0 && [...title].every((w) => query.has(w));
    });
  }
  if (!matches.length || (matches.length === 1 && matches[0].id === currentId)) return null;
  const choices = matches.slice(0, 8).map(({ id, title }) => ({ id, title }));
  return {
    question: matches.length === 1
      ? `You asked about "${matches[0].title}". Open that request below to check its status or continue its conversation.`
      : 'More than one request matches your message. Choose the request you mean below.',
    choices,
  };
}
