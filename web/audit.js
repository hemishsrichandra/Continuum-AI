// Loaded only by an explicitly enabled, non-production QA server.
import '/axe.min.js';
const panel = document.createElement('details');
panel.className = 'a11y-qa'; panel.id = 'accessibility-audit';
panel.innerHTML = '<summary>Accessibility audit: waiting</summary><button type="button">Run again</button><pre></pre>';
document.body.append(panel);
let busy = false, timer;
async function run() {
  if (busy || !document.querySelector('main h1')) return; busy = true;
  try {
    const result = await window.axe.run(document, { exclude: [['#accessibility-audit']], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    panel.querySelector('summary').textContent = `Accessibility audit: ${result.violations.length} violations`;
    panel.querySelector('pre').textContent = JSON.stringify(result.violations.map((v) => ({ id: v.id, impact: v.impact, description: v.description, nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })) })), null, 2);
  } catch (e) { panel.querySelector('summary').textContent = 'Accessibility audit: error'; panel.querySelector('pre').textContent = e.message; }
  finally { busy = false; }
}
panel.querySelector('button').addEventListener('click', run);
new MutationObserver(() => { panel.querySelector('summary').textContent = 'Accessibility audit: waiting'; clearTimeout(timer); timer = setTimeout(run, 500); }).observe(document.querySelector('#app'), { childList: true, subtree: true });
setTimeout(run, 700);
