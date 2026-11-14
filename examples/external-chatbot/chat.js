let conversationId = crypto.randomUUID();
const form = document.querySelector('#chat');
const status = document.querySelector('#status');
const suggestions = document.querySelector('#suggestions');
const clarification = document.querySelector('#clarification');
document.querySelector('#new-conversation').addEventListener('click', () => {
  conversationId = crypto.randomUUID(); suggestions.replaceChildren(); clarification.replaceChildren();
  document.querySelector('#response').textContent = ''; status.textContent = 'New conversation started. Environment facts are sent only with each question.';
});
const element = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };
form.addEventListener('submit', async event => {
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
  suggestions.replaceChildren(); clarification.replaceChildren(); document.querySelector('#response').textContent = '';
  status.textContent = 'Retrieving reviewed company knowledge…';
  try {
    const data = new FormData(form);
    const response = await fetch('/chat', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      question:data.get('question'),conversationId,environment: data.get('environment').trim() ? {environment:data.get('environment').trim()} : {},
    })});
    const result = await response.json();
    document.querySelector('#response').textContent = JSON.stringify(result,null,2);
    if (!response.ok) throw new Error(result.error);
    status.textContent = result.status === 'no_match' ? result.message : result.status === 'clarification_required' ? 'More environment facts are required.' : `${result.suggestions.length} reviewed suggestion(s). Preview only.`;
    for (const item of result.suggestions) {
      const article = document.createElement('article'); article.append(element('h2',item.title));
      const steps = document.createElement('ol'); for (const step of item.steps) steps.append(element('li',step)); article.append(steps);
      article.append(element('p',`Source: ${item.provenance.source}, version ${item.provenance.version}. ID: ${item.id}`));
      if (item.advisory) article.append(element('p',item.advisory));
      if (item.unconfirmedEvidence) article.append(element('p',item.unconfirmedEvidence)); suggestions.append(article);
    }
    for (const requirement of result.clarification) clarification.append(element('p',requirement));
  } catch (error) { status.textContent = error.message || 'Unable to reach the company backend.'; }
  finally { button.disabled = false; }
});
