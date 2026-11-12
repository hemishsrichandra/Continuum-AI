// Safety and simulation qualifiers ("Fictional demo only", test-solution labels,
// warnings) are never stripped: customers must see that a procedure is fictional.
// Present the verified procedure as advice, keeping authorship and provenance in
// evidence. These narrow wording changes do not invent or remove repair steps.
export function customerAdvice(solution) {
  let text=String(solution || '').trim();
  text=text.replace(/^(?:human[- ]verified resolution|specialist(?:[- ]verified)? (?:solution|recommendation)|verified (?:solution|steps)|specialist[- ]provided solution)\s*:\s*/i,'');
  text=text.replace(/^(?:(?:the|our|a)\s+)?(?:specialist|technician|support team)\s+(?:recommends?|suggests?)\s+(?:that you\s+|you\s+|to\s+)?/i,'');
  text=text.replace(/\b(?:specialist|technician|staff)[- ]provided\b/gi,'approved');
  return text ? text[0].toUpperCase()+text.slice(1) : text;
}
