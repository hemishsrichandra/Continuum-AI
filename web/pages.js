import { request, escapeHtml as q, calendarLink, formatDate, readSession, saveSession } from './client.js';

import { initFx, initReveal, initTilt } from './fx.js';
const primaryLinks = [['/', 'Home'], ['/services', 'Product'], ['/about', 'How it works'], ['/pricing', 'Pricing'], ['/demo', 'Demo']];
const legalLinks = [['/privacy', 'Privacy'], ['/terms', 'Terms'], ['/security', 'Security']];
const allLinks = [...primaryLinks, ['/book-a-session', 'Book a call'], ['/style-guide', 'Style guide'], ...legalLinks];
const footerLinks = [...primaryLinks, ['/book-a-session', 'Book a call'], ['/desk', 'Sign in']];
const link = (text, href = '/desk', primary = true) => `<a class="button ${primary ? 'primary' : ''}" href="${href}">${text}${primary ? ' <span aria-hidden="true">→</span>' : ''}</a>`;
const ICON = {
  '↺': '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
  '◈': '<path d="M12 3l8 9-8 9-8-9z"/>',
  '✓': '<path d="M5 12.5l4.5 4.5L19 7"/>',
  '♡': '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  '∿': '<path d="M3 12c3-6 6-6 9 0s6 6 9 0"/>',
  '▦': '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  '⛨': '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  '✦': '<path d="M12 3l1.8 5.6L19.5 10l-5.7 1.6L12 17l-1.8-5.4L4.5 10l5.7-1.4z"/>',
};
// Decorative glyphs become real icons, so they look the same on every device.
const ic = (g) => (ICON[g] ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[g]}</svg>` : g);
const slotSkeleton = () => '<div class="slot-skeleton" aria-hidden="true">' + '<span></span>'.repeat(6) + '</div><p class="sr-only" role="status">Checking availability…</p>';
const button = (text, href = '/desk', primary = true) => `<a class="button ${primary ? 'primary' : ''}" href="${href}">${text}<span aria-hidden="true">↗</span></a>`;
const heading = (label, title, copy) => `<section class="wrap page-hero"><span class="eyebrow">${label}</span><h1>${title}</h1><p class="lead">${copy}</p></section>`;
const cards = (items) => `<div class="cards">${items.map(([icon, title, copy], i) => `<article class="card"><div class="card-top"><span class="tile-icon" aria-hidden="true">${ic(icon)}</span></div><h3>${title}</h3><p>${copy}</p></article>`).join('')}</div>`;
const faq = (items) => `<div class="faq"><div><span class="eyebrow">A LITTLE CLARITY</span><h2>Good questions.<br>Clear answers.</h2></div><div>${items.map(([title, copy]) => `<details><summary>${title}<span aria-hidden="true">+</span></summary><p>${copy}</p></details>`).join('')}</div></div>`;
const cta = () => `<section class="wrap section"><div class="cta"><div><span class="eyebrow">THE NEXT CONVERSATION STARTS HERE</span><h2>Less chasing.<br>More moving forward.</h2><p>A calmer way to keep your support in motion.</p></div><div class="cta-actions">${button('Explore the workspace')}${button('Book a session', '/book-a-session', false)}</div><span class="cta-symbol" aria-hidden="true">∿</span></div></section>`;
const capabilities = [
  ['↺', 'Context that carries forward', 'Remember preferences, earlier fixes, and missed commitments. Spend less time explaining and more time making progress.'],
  ['◈', 'Clarity on every request', 'See current status, expected completion, visit details, and notes in one place. Every update has a source.'],
  ['✓', 'A next step you control', 'Book a visit, add a note, or bring in a specialist. Review the details before anything changes.'],
];
function productPreview() {
  return `<div class="product-preview" aria-label="Preview of the support workspace"><div class="preview-bar"><div class="window-dots" aria-hidden="true"><i></i><i></i><i></i></div><span>YOUR SUPPORT, CONNECTED</span><span class="pill green"><span class="status-dot"></span> Everything in context</span></div><div class="preview-layout"><aside class="preview-sidebar"><div class="preview-brand"><span class="logo">∿</span> My workspace</div><div class="preview-sidebar-label">REQUESTS <span>02</span></div><div class="preview-request active"><small>SR-2048</small><b>MacBook Pro</b><span>Display replacement</span><span class="pill blue">Waiting for part</span></div><div class="preview-request"><small>YOUR NEXT STEP</small><b>Visit your service team</b><span>Choose an available time</span></div><div class="preview-sidebar-bottom"><span class="avatar">AM</span><span>Alice Morgan<small>Device Repair</small></span></div></aside><div class="preview-conversation"><div class="preview-conversation-heading"><span class="assistant-mark">∿</span><div><b>Continuum assistant</b><small>Picking up where you left off</small></div><span class="pill green">Memory on</span></div><div class="preview-messages"><div class="bubble customer">Any update on my laptop repair?</div><div class="assistant-response"><span class="assistant-mark">∿</span><div><p>Your display replacement is waiting for a part. I’ve also kept your preference to receive a call before any paid work goes ahead.</p><div class="evidence-tags"><span>◈ Service record</span><span>↺ Callback preference</span></div></div></div><div class="preview-saved"><span>✓</span><div><b>A little detail. A better experience.</b><small>You shouldn’t have to explain it twice.</small></div></div></div><div class="preview-compose"><span>Ask about your request…</span><span class="send-icon" aria-hidden="true">↑</span></div></div><aside class="preview-context"><span class="eyebrow">REMEMBERED CONTEXT</span><div class="mini-note"><span class="pill">Preference</span><p>Call before approving paid repairs.</p><small>Available for the next conversation</small></div><div class="preview-next"><span class="eyebrow">NEXT STEPS</span><span>Add a note <b>↗</b></span><span>Book a visit <b>↗</b></span><span>Request a specialist <b>↗</b></span></div></aside></div><div class="preview-caption"><span>Sample workspace</span><a href="/desk">Open your workspace →</a></div></div>`;
}
function home() {
  const faqItems = [
    ['What can I do in the workspace?', 'Describe a problem and get a suggested fix, follow your requests, add notes, book or cancel visits, and ask for a specialist whenever you want one.'],
    ['Where do the suggested fixes come from?', 'From your company’s own playbooks and from fixes that earlier customers confirmed worked. Every suggestion shows where it came from, and unconfirmed fixes are clearly labelled.'],
    ['Is my information shared with other companies?', 'No. Each company’s knowledge stays its own, and personal details are removed before anything is saved for reuse.'],
    ['Does anything happen without my say-so?', 'No. You review and confirm each action first, and the workspace shows the saved result and your history.'],
  ];
  return `<section class="wrap hero3d"><canvas id="scene" aria-hidden="true"></canvas><div class="copy">
    <div class="eyebrow"><span class="status-dot"></span> SUPPORT THAT REMEMBERS WHAT WORKS</div>
    <h1>Good support<br><span class="grad">remembers.</span></h1>
    <p class="lead">Fixes your customers confirm and your team reviews become answers for the next customer. Kept by your company, never shared with another.</p>
    <div class="actions">${link('Try the demo', '/demo', true)}${link('See how it works', '/about', false)}</div>
    <div class="fx-chips" aria-hidden="true"><span class="fx-chip"><span class="status-dot"></span>Fix confirmed by Customer A</span><span class="fx-chip">${ic('✦')}Matched for Customer B</span><span class="fx-chip">${ic('⛨')}Company-private</span></div>
  </div></section>

  <section class="wrap guarantees reveal" aria-label="What every answer has passed">
    <ul class="guarantee-bar">
      <li>${ic('◈')}<span><b>Matched to the device</b>Model and version checked</span></li>
      <li>${ic('⛨')}<span><b>Safe by default</b>Your safety rules come first</span></li>
      <li>${ic('✓')}<span><b>Confirmed by people</b>Reused only after it worked</span></li>
      <li>${ic('↺')}<span><b>Private to you</b>Never shared between companies</span></li>
    </ul>
  </section>

  <section class="wrap sec3d" id="product"><div class="sec-head reveal"><div><span class="eyebrow">THE WORKSPACE</span><h2>One calm place for<br>every request.</h2></div><p>The conversation in the middle, your context on the right, and every answer labelled with where it came from.</p></div>
    <div class="scene3d reveal has-sample-tag"><span class="sample-tag">Sample workspace</span><div class="ws-mock product-preview" data-tilt="6" aria-label="Preview of the support workspace with sample data">
      <aside><div class="ws-tag">REQUESTS</div><div class="ws-req on"><b>MacBook Pro</b>Display flickers<br><span class="pill amber">Waiting for part</span></div><div class="ws-req"><b>Wi-Fi keeps dropping</b>Resolved yesterday</div><div class="ws-req"><b>Printer paper jam</b>New</div></aside>
      <div class="main"><div class="ws-bubble me">My display flickers after startup.</div><div class="ws-bubble">Here’s a fix that worked for a customer with your model: <b>open Display settings, choose the Standard profile and restart.</b><div class="ws-src"><span class="pill green">${ic('✓')}Confirmed by a customer</span><span>Model X · firmware 4</span></div></div>
        <div class="ws-actions"><span class="button primary small">It worked</span><span class="button small">Still need help</span><span class="button small">Talk to a person</span></div></div>
      <aside><div class="ws-tag">YOUR CONTEXT</div><div class="ws-req on"><b>Call before paid repairs</b>Saved preference</div><div class="ws-req"><b>Earlier restart didn’t help</b>Won’t be suggested again</div><div class="ws-tag spaced">NEXT STEP</div><div class="ws-req">Book a visit →</div></aside>
    </div></div></section>

  <section class="story3d" id="how"><div class="pin wrap">
    <div class="story-steps"><span class="eyebrow">HOW IT WORKS</span>
      <div class="story-step"><h3><span class="num">01</span>A customer reports a problem</h3><p>They describe it in their own words and get a safe first suggestion.</p></div>
      <div class="story-step"><h3><span class="num">02</span>A specialist solves it</h3><p>When the suggestion fails, a person writes the fix and what it applies to.</p></div>
      <div class="story-step"><h3><span class="num">03</span>The customer confirms</h3><p>A fix the customer confirms becomes trusted company knowledge. Anything unconfirmed stays clearly labelled.</p></div>
      <div class="story-step"><h3><span class="num">04</span>The next customer is helped</h3><p>A matching problem gets the verified fix, checked against device and safety.</p></div></div>
    <div class="story-stack scene3d" aria-hidden="true">
      <div class="story-card"><span class="who">CUSTOMER A</span><div class="big">“My screen flickers after startup.”</div><span class="pill">Standard suggestion: restart. Didn’t help.</span></div>
      <div class="story-card"><span class="who">SPECIALIST</span><div class="big">Switch Refresh Mode to Fixed 60 Hz.</div><span class="pill blue">Applies to: Model X · firmware 4</span></div>
      <div class="story-card"><span class="who">CUSTOMER A CONFIRMS</span><div class="big">It worked. <span class="grad">Memory: 0 → 1</span></div><span class="pill green">${ic('✓')}Customer-confirmed</span></div>
      <div class="story-card"><span class="who">CUSTOMER B</span><div class="big">“The monitor blinks when it boots.”</div><span class="pill green">${ic('✦')}Matched A’s verified fix</span></div></div>
  </div></section>

  <section class="wrap sec3d" id="journey"><div class="sec-head reveal"><div><h2>Watch a fix<br><span class="grad">teach the system.</span></h2></div><p>One problem, from the first report to the next customer’s answer. Try the same steps yourself in the demo.</p></div>
    <div class="journey reveal"><ol class="path">
      <li class="node"><i aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7"/></svg></i><b>Customer A</b><small>Reports it</small></li>
      <li class="node"><i aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 6l4 4-8 8H6v-4z"/><path d="M13 7l4 4"/></svg></i><b>Specialist</b><small>Writes the fix</small></li>
      <li class="node"><i aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></i><b>Confirmed</b><small>“It worked”</small></li>
      <li class="node"><i aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c.8-4 3-6 6-6s5.2 2 6 6M15 14c3 0 4.6 1.6 5.4 5"/></svg></i><b>Customer B</b><small>Gets the fix</small></li></ol>
      <div class="meter"><div><span class="eyebrow">LEARNED MEMORY</span><div class="count" id="j-count" aria-hidden="true">0</div></div><p id="j-caption">Customer A reports a flickering screen.</p></div></div></section>

  <section class="wrap sec3d"><div class="sec-head reveal"><div><span class="eyebrow">WHY IT FEELS DIFFERENT</span><h2>Trusted answers,<br>not guesses.</h2></div><p>Three promises the product keeps.</p></div>
    <div class="tilt-cards scene3d">
      <article class="tilt-card card reveal"><div class="ic" aria-hidden="true">${ic('✓')}</div><h3>Verified by people</h3><p>Customer-confirmed fixes are marked as such. Imported, owner-approved and unconfirmed fixes carry their own label and are never presented as confirmed.</p></article>
      <article class="tilt-card card reveal"><div class="ic" aria-hidden="true">${ic('⛨')}</div><h3>Safe by default</h3><p>Fixes are checked against your device, version and safety rules before they are ever shown.</p></article>
      <article class="tilt-card card reveal"><div class="ic" aria-hidden="true">${ic('◈')}</div><h3>Private to your company</h3><p>Each company’s knowledge stays its own. Personal details are removed before anything is saved.</p></article>
    </div></section>

  <section class="band"><div class="wrap section reveal">${faq(faqItems)}</div></section>
  <section class="wrap section reveal"><div class="cta"><h2>Less chasing.<br><span class="grad">More moving forward.</span></h2><p class="lead centered-lead">See one customer’s fix help the next one. It takes about two minutes.</p>${link('Try the demo', '/demo', true)}</div></section>`;
}
function about() {
  return heading('OUR APPROACH', 'A little context.<br>A more human experience.', 'We believe the next conversation should build on the last one.') + `<section class="wrap section split story-section"><div><span class="eyebrow">WHY WE BUILT CONTINUUM</span><h2>Start with the person.<br>Keep the details.</h2></div><div class="prose"><p>Good support is rarely about one ticket. It’s the callback you asked for, the fix that didn’t work, or the deadline that passed.</p><p>Continuum brings those details alongside the latest service record. So a returning customer can move forward without starting over.</p><p>Our foundation is simple: make the source clear, keep useful context, and leave the final decision with the person asking for help.</p></div></section><section class="band"><div class="wrap section"><span class="eyebrow">PRINCIPLES IN PRACTICE</span><h2>Thoughtful by design.</h2>${cards([['♡', 'Respect the person', 'Keep the useful details. Give people a clear way to retire context they no longer want used.'], ['◈', 'Show the source', 'Current status comes from the service record. Historical context comes from memory. Both are open to inspection.'], ['✓', 'Make control visible', 'Explain the next step and ask for confirmation. Then show the result in the request’s activity history.']])}</div></section>${cta()}`;
}
function services() {
  const blocks = [
    ['01', 'One place for<br>every next step.', 'A live request view brings status, notes, visits, and outcomes together. Search and filter your requests, then move straight into the conversation.', ['Service record', 'Saved conversation', 'Confirmed action']],
    ['02', 'Remember what<br>makes a difference.', 'Carry preferences and service history forward. Inspect the evidence, summarize the context, or retire an outdated detail. Compare memory on and off in the built-in lab.', ['Relevant history', 'Recall & reflection', 'A better response']],
    ['03', 'Move forward.<br>With confidence.', 'Book a visit, cancel when plans change, or prepare a specialist handoff. Your updates persist, and repeated submissions are protected against duplicates.', ['Review details', 'Confirm your choice', 'See the saved result']],
  ];
  return heading('THE CONTINUUM WORKSPACE', 'Less switching.<br>More understanding.', 'The service record, the conversation, and the useful details — brought together.') + `<section class="wrap">${productPreview()}</section><section class="wrap section">${blocks.map(([n, title, copy, steps]) => `<article class="split feature-block"><div><span class="eyebrow">${n} / BUILT FOR PROGRESS</span><h2>${title}</h2><p class="lead">${copy}</p>${button('See it in the demo', '/demo', false)}</div><div class="diagram" role="img" aria-label="${steps.join(' to ')}">${steps.map((step, i) => `${i ? '<span class="diagram-arrow" aria-hidden="true">↓</span>' : ''}<div><span class="tile-icon" aria-hidden="true">${ic(['◈', '∿', '✓'][i])}</span><b>${step}</b></div>`).join('')}</div></article>`).join('')}</section>${cta()}`;
}
const featureHints = {
  'Team seats': 'People who can sign in as owners or specialists. Customers never need a seat.',
  'Provider connections': 'Systems Continuum reads from, such as a ticket tool, a customer directory or a knowledge spreadsheet.',
  'Memory & evidence': 'Fixes customers confirm become reusable answers, each labelled with where it came from.',
  'Visit management': 'Customers book, move or cancel visits themselves, with a calendar file or calendar sync.',
  'Outcomes & activity': 'Every attempt, outcome and confirmation is kept on the request’s timeline.',
};
function pricing() {
  const plans = [['Starter', 29, 'A focused beginning.', ['3 seats', '1 provider connection', 'Saved conversations', 'Memory & service actions']], ['Growth', 79, 'A more connected team.', ['10 seats', '2 provider connections', 'Everything in Starter', 'Priority onboarding']], ['Enterprise', null, 'Shaped around your team.', ['Custom seat count', 'Custom integrations', 'Deployment planning', 'Dedicated onboarding']]];
  return heading('PRICING', 'Simple plans.<br>Thoughtful support.', 'Per-seat pricing for support teams of every size. We set up every workspace with you, and early-access teams keep these prices.') + `<section class="wrap pricing-section"><div class="billing" role="group" aria-label="Billing period"><button data-billing="monthly" aria-pressed="true">Monthly</button><button data-billing="annual" aria-pressed="false">Annually <span>−20%</span></button></div><div class="cards pricing-cards">${plans.map(([name, price, desc, features]) => `<article class="card price-card ${name === 'Growth' ? 'featured' : ''}"><div class="plan-heading"><h2>${name}</h2>${name === 'Growth' ? '<span class="pill blue">For growing teams</span>' : ''}</div><p>${desc}</p><div class="price">${price ? `<strong data-price="${price}">$${price}</strong><span>/ seat / month</span>` : '<strong>Let’s talk.</strong>'}</div><p class="billing-note">${price ? 'Billed monthly in USD' : 'A conversation about what you need'}</p>${button(price ? 'Request early access' : 'Talk to us', '/book-a-session?plan=' + name, name === 'Growth')}<ul class="checklist">${features.map((f) => `<li>${f}</li>`).join('')}</ul></article>`).join('')}</div><p class="fine-print centered">No card needed to request access. You can explore every workflow in the <a href="/demo">interactive demo</a> today.</p></section><section class="band"><div class="wrap section"><span class="eyebrow">WHAT’S INSIDE</span><h2>The essentials, connected.</h2><div class="table-scroll" role="region" aria-label="Plan comparison" tabindex="0"><table><caption>Plan comparison</caption><thead><tr><th scope="col">Feature</th><th scope="col">Starter</th><th scope="col">Growth</th><th scope="col">Enterprise</th></tr></thead><tbody>${[['Team seats', '3', '10', 'Custom'], ['Provider connections', '1', '2', 'Custom'], ['Saved conversations', 'Included', 'Included', 'Included'], ['Memory & evidence', 'Included', 'Included', 'Included'], ['Visit management', 'Included', 'Included', 'Included'], ['Outcomes & activity', 'Included', 'Included', 'Included'], ['Custom integrations', '—', '—', 'Scoped together'], ['Onboarding', 'Self-serve', 'Priority', 'Dedicated']].map((row) => `<tr><th scope="row">${row[0]}${featureHints[row[0]] ? `<span class="hint" tabindex="0" role="note" aria-label="${featureHints[row[0]]}" data-hint="${featureHints[row[0]]}">?</span>` : ''}</th>${row.slice(1).map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div></section><section class="wrap section">${faq([['How does annual pricing work?', 'Annual billing applies a 20% discount. Starter is $23.20 per seat per month, billed at $278.40 annually. Growth is $63.20 per seat per month, billed at $758.40 annually.'], ['What does early access mean?', 'The product is ready to use with your team. We onboard each early-access company personally, and the prices on this page stay the same for you after general availability.'], ['Can I try the product now?', 'Yes. The interactive demo is open to everyone, and no payment details are needed to request access.'], ['What if I need a custom integration?', 'Choose Enterprise when reserving a walkthrough and describe your workflow. Custom integrations would be scoped separately.']])}</section>`;
}

// Legal and trust pages. They describe what the product does today; the terms are an early-access draft and say so.
const legalPage = (label, title, intro, sections, note) => heading(label, title, intro) + `<section class="wrap section legal"><p class="legal-updated">Last updated 13 November 2026</p><nav class="legal-toc" aria-label="On this page"><span class="eyebrow">ON THIS PAGE</span>${sections.map(([h], i) => `<a href="#s${i + 1}">${h}</a>`).join('')}</nav><div class="prose legal-body">${sections.map(([h, body], i) => `<h2 id="s${i + 1}">${h}</h2>${body}`).join('')}${note ? `<p class="fine-print legal-status">${note}</p>` : ''}<p class="fine-print">Questions about this page? <a href="/book-a-session">Book a call</a> and we’ll answer them directly.</p></div></section>`;
function privacyPage() {
  return legalPage('PRIVACY', 'Your information,<br>handled with care.', 'What Continuum keeps, why it keeps it, and what is removed before anything is reused.', [
    ['What we store', '<p>Requests and their status, the conversation with the assistant, remembered preferences (for example “call me before paid repairs”), troubleshooting attempts and visits. Each company’s data is stored separately from every other company’s.</p>'],
    ['What becomes shared knowledge', '<p>Only a fix that a specialist wrote and a customer confirmed (or an owner reviewed) becomes reusable knowledge, and only inside the same company. Before it is saved, emails, phone numbers, addresses, customer and device identifiers, names after words like “ask” or “from”, and anything that looks like a password or key are removed. Text that looks like a credential is rejected outright.</p>'],
    ['What we never do', '<ul><li>Share one company’s knowledge with another company.</li><li>Log the content of requests. Logs hold error messages only.</li><li>Send customer text to an outside AI service unless the company has configured one, and then only text that has already been scrubbed.</li></ul>'],
    ['Removing your information', '<p>A customer can choose “Remove my conversation content” for one request or all of them. Messages, remembered context and preferences learned from them, copies in case files and diagnostic answers are cleared. Customers can also withdraw fixes that were learned from their requests.</p><p>Some records are kept so that work in progress is not broken: the request itself, visits, specialist updates and counts such as how often a fix worked. Backups made before a removal keep their copy until they are rotated.</p>'],
    ['Retention', '<p>Companies can set how long archived conversations, finished follow-ups and delivered notifications are kept, after which they are deleted automatically.</p>'],
    ['Cookies', '<p>Continuum uses one essential sign-in cookie, and only after you sign in. There are no advertising or tracking cookies. Your light or dark theme choice is kept in your own browser.</p>'],
  ], 'This policy describes how Continuum handles data today and will be updated as the product changes.');
}
function termsPage() {
  return legalPage('TERMS', 'Early-access<br>terms.', 'The plain-language basis on which teams use Continuum during early access.', [
    ['Early access', '<p>Continuum is offered to early-access companies by agreement. Features may change, and we will tell you before any change that affects how your team works.</p>'],
    ['Your data stays yours', '<p>Your company owns its requests, conversations and knowledge. We process them only to run Continuum for you, and we do not use one company’s data to help another company.</p>'],
    ['Acceptable use', '<p>Use Continuum for genuine support work. Don’t upload data you are not allowed to share, try to reach another company’s workspace, or use the service to send unsolicited messages.</p>'],
    ['Suggested fixes', '<p>Suggestions are labelled with where they came from. Customer-confirmed and reviewed fixes are checked against device, version and safety rules, but a person should still use judgement before acting, especially for paid or physical repairs.</p>'],
    ['Ending early access', '<p>Either side can end early access with notice. You can export or remove your data before it ends.</p>'],
  ], 'Early-access terms. A signed agreement with your company takes precedence over this page.');
}
function securityPage() {
  return legalPage('SECURITY', 'Built to keep each<br>company’s knowledge its own.', 'The safeguards built into Continuum, in plain words.', [
    ['Company isolation', '<p>Every request, conversation and fix belongs to one company and one support service. Search, suggestions and the knowledge library only ever look inside the signed-in company, and tests check that one company can never see another’s data.</p>'],
    ['Accounts and sign-in', '<p>Passwords are stored as slow, salted scrypt hashes and must be at least 15 characters. Sessions use secure, HTTP-only cookies with protection against cross-site request forgery, and you can sign out every device from your account settings. Each person has a separate role in each company.</p>'],
    ['Secrets and connections', '<p>Credentials for connected systems are encrypted at rest and are never sent to the browser. Imports are checked for personal data and for text that tries to give the assistant instructions.</p>'],
    ['Safe suggestions', '<p>A fix is only shown when it matches the customer’s device and version and passes its safety restrictions. A fix that fails is flagged for review rather than repeated.</p>'],
    ['Browser protections', '<p>Pages are served with a strict content security policy, no framing by other sites, and no third-party scripts.</p>'],
    ['Reporting a problem', '<p>If you think you have found a security issue, please <a href="/book-a-session">book a call</a> and mark it urgent. We will respond and keep you updated until it is fixed.</p>'],
  ]);
}
function booking() {
  return heading('A LITTLE TIME, WELL SPENT', 'Let’s look at<br>your next conversation.', 'Reserve a 30-minute session to explore a more connected support experience.') + `<section class="wrap split booking-layout"><div class="booking-intro"><span class="eyebrow">30 MINUTES. A CLEARER PICTURE.</span><h2>Bring your questions.<br>We’ll bring the context.</h2><ol class="agenda"><li><span>01</span><div><b>Your support today</b><p>Your team, your workflow, and the friction points.</p></div><small>5 min</small></li><li><span>02</span><div><b>A guided walkthrough</b><p>Service status, memory, and confirmed next steps.</p></div><small>15 min</small></li><li><span>03</span><div><b>A path forward</b><p>Questions, integration needs, and possibilities.</p></div><small>10 min</small></li></ol><div class="booking-note"><span class="tile-icon" aria-hidden="true">${ic('▦')}</span><p>Your reservation is saved in Continuum.<br><small>Download a calendar file any time. Signed-in users with a connected calendar can sync reservations.</small></p></div></div><section class="panel booking-panel"><div id="booking-receipt" hidden></div><div id="booking-form-area"><span class="eyebrow">CHOOSE YOUR TIME</span><h2>Make a little room.</h2><form id="session-form"><div class="form-pair"><label>Your name<input name="name" autocomplete="name" required maxlength="100" placeholder="Alex Morgan"></label><label>Work email<input type="email" name="email" autocomplete="email" required maxlength="200" placeholder="alex@company.com"></label></div><div class="form-pair"><label>I’m interested in<select name="plan"><option>Just exploring</option><option>Starter</option><option>Growth</option><option>Enterprise</option></select></label><label>Choose a day<select name="date" required disabled><option value="">Loading dates…</option></select></label></div><fieldset><legend>Available times · India Standard Time (UTC+05:30)</legend><div id="demo-slots" class="slot-grid">${slotSkeleton()}</div></fieldset><label>Anything you’d like to explore?<textarea name="notes" maxlength="500" placeholder="Tell us a little about your team (optional)"></textarea></label><button class="button primary full" type="submit" disabled>Reserve session →</button><p id="booking-result" class="notice error" role="alert" hidden></p><button class="text-button" type="button" id="retry-slots" hidden>Check availability again</button></form></div></section></section><dialog id="cancel-reservation" aria-labelledby="cancel-title"><h2 id="cancel-title">Cancel your reservation?</h2><p>This releases your time for someone else. You can reserve another session whenever you’re ready.</p><p class="notice error" id="cancel-error" hidden role="alert"></p><div class="dialog-buttons"><button class="button" id="keep-reservation">Keep my session</button><button class="button primary" id="confirm-cancel">Cancel reservation</button></div></dialog>`;
}
const swatches = [['Accent', '--blue', '#B8F2D0 dark · #2B0F16 light'], ['Ink', '--ink', '#F3E9DC dark · #2B0F16 light'], ['Page', '--white', '#1C0A10 dark · #F3E9DC light'], ['Raised surface', '--soft', '#3B1824 dark · #E8DACA light'], ['Muted text', '--muted', 'rgba(24,24,24,0.65)'], ['Border', '--line', 'rgba(24,24,24,0.08)']];
function styleGuide() {
  return heading('OUR DESIGN LANGUAGE', 'Clarity at every scale.', 'The foundations behind a calm, consistent experience.') + `<section class="wrap section"><span class="eyebrow">01 / TYPOGRAPHY</span><h2>Room for the words to work.</h2><div class="type-spec">${[1, 2, 3, 4, 5, 6].map((n) => `<div><code>H${n}</code><h${n}>Support that moves you forward.</h${n}></div>`).join('')}<div><code>Lead</code><p class="lead">A little context makes a world of difference.</p></div><div><code>Body</code><p>Useful information, in a voice that feels human.</p></div></div></section><section class="band"><div class="wrap section"><span class="eyebrow">02 / PALETTE</span><h2>Calm, with a spark.</h2><div class="cards swatches">${swatches.map(([name, variable, color], i) => `<article class="card"><div class="swatch swatch-${i}"></div><h3>${name}</h3><code>${variable}</code><small>${color}</small></article>`).join('')}</div></div></section><section class="wrap section"><span class="eyebrow">03 / COMPONENTS</span><h2>Made to work together.</h2><div class="actions"><button class="button primary" data-example>Primary action ↗</button><button class="button" data-example>Secondary action</button><button class="button demo-focus" data-example>Focus state</button><button class="button" disabled>Disabled</button></div><p id="example-result" class="muted" role="status"></p>${cards(capabilities)}<div class="split spec-block"><div><h3>Form inputs</h3><label>Email address<input type="email" placeholder="you@company.com"></label><label>Team size<select><option>1–10 people</option><option>11–50 people</option><option>50+ people</option></select></label><label>Message<textarea placeholder="How can we help?"></textarea></label></div><div><h3>Pills & foundations</h3><div class="actions"><span class="pill">Default</span><span class="pill blue">In progress</span><span class="pill green">Confirmed</span></div><p class="muted">1280px container · 8px card radius<br>6px buttons · 9999px pills<br>Visible focus · reduced motion support</p></div></div></section>`;
}
async function setupBooking() {
  const form = document.querySelector('#session-form'); if (!form) return;
  const area = document.querySelector('#booking-form-area'); const receipt = document.querySelector('#booking-receipt');
  const date = form.elements.date; const slotArea = document.querySelector('#demo-slots');
  const result = document.querySelector('#booking-result'); const submit = form.querySelector('[type=submit]');
  const plan = new URLSearchParams(location.search).get('plan');
  if (['Starter', 'Growth', 'Enterprise'].includes(plan)) form.elements.plan.value = plan;
  let slots = [], key = crypto.randomUUID(), saved, calendarUrl, loading = false;
  const showError = (text) => { result.hidden = false; result.textContent = text; };
  function renderTimes() {
    const available = slots.filter((s) => s.date === date.value);
    slotArea.innerHTML = available.map((s) => `<label class="slot"><input type="radio" name="datetime" value="${q(s.id)}" required><span>${s.time}</span></label>`).join('') || '<p class="muted">No times available. Choose another day.</p>';
    submit.disabled = !available.length;
  }
  async function loadSlots() {
    if (loading) return; loading = true; submit.disabled = true;
    slotArea.innerHTML = slotSkeleton();
    document.querySelector('#retry-slots').hidden = true;
    try {
      ({ slots } = await request('demo-slots'));
      const dates = [...new Set(slots.map((s) => s.date))]; const previous = date.value;
      date.innerHTML = dates.map((d) => `<option value="${d}">${new Intl.DateTimeFormat('en-IN', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(d + 'T12:00:00+05:30'))}</option>`).join('');
      if (dates.includes(previous)) date.value = previous;
      date.disabled = !dates.length; renderTimes();
    } catch (e) { showError(e.message); document.querySelector('#retry-slots').hidden = false; }
    finally { loading = false; }
  }
  function showReceipt() {
    area.hidden = true; receipt.hidden = false;
    if (calendarUrl) URL.revokeObjectURL(calendarUrl);
    calendarUrl = calendarLink(saved);
    receipt.innerHTML = `<span class="receipt-check" aria-hidden="true">✓</span><span class="eyebrow">${saved.status === 'Cancelled' ? 'RESERVATION CANCELLED' : 'YOU’RE ON THE CALENDAR'}</span><h2>${saved.status === 'Cancelled' ? 'Plans change.<br>We understand.' : 'A little time.<br>A clearer next step.'}</h2><div class="receipt-time"><b>${formatDate(saved.datetime, true)} IST</b><span>30-minute session</span></div><p class="muted">${saved.status === 'Cancelled' ? 'Your slot has been released. Reserve a new time whenever you’re ready.' : 'Your reservation is saved. Add it to your calendar to keep the time handy.'}</p>${saved.status !== 'Cancelled' ? `<a class="button primary full" href="${calendarUrl}" download="continuum-session.ics">Add to calendar ↓</a><button class="text-button" id="cancel-session">Cancel reservation</button>` : '<button class="button primary" id="new-session">Choose another time →</button>'}<p class="fine-print">Reference ${q(saved.id.slice(0, 8).toUpperCase())} · ${saved.emailDelivery === 'delivered' ? 'Confirmation accepted by the email provider.' : saved.emailDelivery === 'queued' || saved.emailDelivery === 'pending' || saved.emailDelivery === 'processing' ? 'Confirmation email queued.' : saved.emailDelivery === 'failed' ? 'Email could not be sent. Your reservation is still saved.' : 'Email delivery is not enabled; please download your calendar file.'}</p>`;
    receipt.querySelector('#cancel-session')?.addEventListener('click', () => document.querySelector('#cancel-reservation').showModal());
    receipt.querySelector('#new-session')?.addEventListener('click', () => { saveSession('supportly-reservation', null); saved = null; area.hidden = false; receipt.hidden = true; form.reset(); key = crypto.randomUUID(); loadSlots(); });
  }
  date.addEventListener('change', renderTimes);
  form.addEventListener('change', () => { key = crypto.randomUUID(); result.hidden = true; });
  document.querySelector('#retry-slots').addEventListener('click', () => { result.hidden = true; loadSlots(); });
  document.querySelector('#keep-reservation').addEventListener('click', () => document.querySelector('#cancel-reservation').close());
  document.querySelector('#confirm-cancel').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try { const status = await request('demo-bookings/manage', { body: { id: saved.id, manageToken: saved.manageToken, cancel: true, confirmed: true } }); saved = { ...saved, ...status }; saveSession('supportly-reservation', JSON.stringify(saved)); document.querySelector('#cancel-reservation').close(); showReceipt(); }
    catch (e) { const error = document.querySelector('#cancel-error'); error.hidden = false; error.textContent = e.message; }
    finally { event.target.disabled = false; }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (submit.disabled) return;
    submit.disabled = true; submit.textContent = 'Reserving your session…'; result.hidden = true;
    const data = Object.fromEntries(new FormData(form)); delete data.date;
    const fields = [...form.querySelectorAll('input, textarea, select')]; fields.forEach((field) => field.disabled = true);
    try { saved = await request('demo-bookings', { body: { ...data, confirmed: true }, key }); saveSession('supportly-reservation', JSON.stringify(saved)); showReceipt(); }
    catch (e) { showError(e.message); if (e.status === 409) { key = crypto.randomUUID(); await loadSlots(); } }
    finally { fields.forEach((field) => field.disabled = false); submit.disabled = !slots.length; submit.textContent = 'Reserve session →'; }
  });
  try {
    const previous = JSON.parse(readSession('supportly-reservation') || 'null');
    if (previous?.manageToken) { saved = { ...previous, ...await request('demo-bookings/manage', { body: { id: previous.id, manageToken: previous.manageToken } }) }; showReceipt(); return; }
  } catch { saveSession('supportly-reservation', null); }
  await loadSlots();
}
export function mountSite() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const nav = document.querySelector('#site-nav');
  nav.innerHTML = primaryLinks.map(([href, text]) => `<a href="${href}" ${href === path ? 'aria-current="page"' : ''}>${text}</a>`).join('') + '<a class="mobile-session" href="/desk">Sign in</a><a class="mobile-session" href="/demo">Try the demo</a>';
  const toggle = document.querySelector('.menu-toggle');
  const close = () => { toggle.setAttribute('aria-expanded', 'false'); nav.classList.remove('open'); };
  toggle.addEventListener('click', () => { const expanded = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(expanded)); nav.classList.toggle('open', expanded); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('open')) { close(); toggle.focus(); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.nav')) close(); });
  const pages = { '/': home, '/about': about, '/services': services, '/pricing': pricing, '/book-a-session': booking, '/style-guide': styleGuide, '/privacy': privacyPage, '/terms': termsPage, '/security': securityPage };
  const app = document.querySelector('#app'); if (pages[path]) app.innerHTML = pages[path]();
  // The server writes each public page's title and description; only the internal style guide sets its own.
  if (path === '/style-guide') document.title = 'Style guide — Continuum';
  const footer = document.createElement('footer'); footer.className = 'site-footer';
  footer.innerHTML = `<div class="wrap footer-top"><div><a class="brand" href="/"><span class="logo" aria-hidden="true">∿</span> Continuum<span class="brand-dot">.</span></a><p>Good support remembers.</p></div><nav aria-label="Footer navigation">${footerLinks.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}</nav><nav class="footer-legal" aria-label="Legal and trust">${legalLinks.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}</nav></div><div class="wrap footer-bottom"><span>© ${new Date().getFullYear()} Continuum</span><span>Thoughtful support, connected.</span><a href="/desk">Your workspace ↗</a></div>`;
  document.body.append(footer);
  document.querySelectorAll('[data-billing]').forEach((button) => button.addEventListener('click', () => {
    const annual = button.dataset.billing === 'annual';
    document.querySelectorAll('[data-billing]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    document.querySelectorAll('[data-price]').forEach((price) => { const base = Number(price.dataset.price); price.textContent = '$' + (annual ? (base * .8).toFixed(2) : base); price.closest('article').querySelector('.billing-note').textContent = annual ? `$${(base * .8 * 12).toFixed(2)} per seat billed annually in USD` : 'Billed monthly in USD'; });
  }));
  document.querySelectorAll('[data-example]').forEach((button) => button.addEventListener('click', () => { document.querySelector('#example-result').textContent = 'Action activated. Clear feedback is part of the experience.'; }));
  setupBooking();
  // Depth, reveal and the 3D scene: progressive enhancement after the page is built.
  initFx();
}
