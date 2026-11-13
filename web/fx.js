// Motion and depth helpers shared by every page. Everything here is progressive enhancement: with JavaScript blocked, with
// reduced-motion on, or without WebGL, the pages remain complete and readable.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function initTheme() {
  const actions = document.querySelector('.nav-actions, .demo-nav nav');
  if (!actions || document.querySelector('.theme-toggle')) return;
  const button = document.createElement('button');
  button.className = 'theme-toggle';
  button.type = 'button';
  const sync = () => {
    const light = document.documentElement.dataset.theme === 'light';
    // One SVG icon set across the site, so the toggle looks the same on every device and font.
    button.innerHTML = light
      ? '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>'
      : '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    button.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    button.title = button.getAttribute('aria-label');
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', light ? '#f3e9dc' : '#150a0f');
  };
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* remembering is optional */ }
    sync();
  });
  actions.prepend(button);
  sync();
}

export function initProgress() {
  if (document.querySelector('.scroll-progress')) return;
  const bar = document.createElement('div');
  bar.className = 'scroll-progress';
  bar.setAttribute('aria-hidden', 'true');
  document.body.append(bar);
  const update = () => { const max = document.documentElement.scrollHeight - innerHeight; bar.style.width = (max > 0 ? (scrollY / max) * 100 : 0) + '%'; };
  addEventListener('scroll', update, { passive: true });
  update();
}

export function initReveal(root = document) {
  const items = [...root.querySelectorAll('.reveal:not(.in)')];
  if (!items.length) return;
  if (reduce || !('IntersectionObserver' in window)) { items.forEach((el) => el.classList.add('in')); return; }
  // An observer alone can miss an element that enters and leaves between two frames (a fast scroll or a jump link),
  // leaving it invisible for good. So anything whose top has reached the viewport, or already scrolled past it, is shown.
  const pending = new Set(items);
  let frame = 0;
  const show = (el) => { el.classList.add('in'); pending.delete(el); io.unobserve(el); };
  const sweep = () => {
    frame = 0;
    pending.forEach((el) => { if (el.getBoundingClientRect().top < innerHeight * 0.92) show(el); });
    if (!pending.size) removeEventListener('scroll', onScroll);
  };
  const onScroll = () => { if (!frame) frame = requestAnimationFrame(sweep); };
  const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) show(e.target); }), { threshold: 0 });
  items.forEach((el) => io.observe(el));
  addEventListener('scroll', onScroll, { passive: true });
  sweep();
}

export function initTilt(root = document) {
  if (reduce) return;
  root.querySelectorAll('[data-tilt]').forEach((el) => {
    if (el.dataset.tiltReady) return;
    el.dataset.tiltReady = '1';
    const max = Number(el.dataset.tilt) || 6;
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      el.style.transform = `rotateX(${(0.5 - y) * max}deg) rotateY(${(x - 0.5) * max}deg)`;
      el.style.setProperty('--mx', x * 100 + '%');
      el.style.setProperty('--my', y * 100 + '%');
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  });
}

/** Pinned scroll story: scroll position drives four 3D cards. */
export function initStory() {
  const story = document.querySelector('.story3d');
  if (!story || reduce) return;
  const steps = [...story.querySelectorAll('.story-step')], cards = [...story.querySelectorAll('.story-card')];
  const render = () => {
    if (innerWidth <= 900) { steps.forEach((s) => s.classList.add('on')); cards.forEach((c) => { c.style.transform = ''; c.style.opacity = ''; c.style.removeProperty('--c'); }); return; }
    const r = story.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, -r.top / (story.offsetHeight - innerHeight)));
    const s = p * (cards.length - 1);
    steps.forEach((el, i) => el.classList.toggle('on', Math.round(s) === i));
    cards.forEach((c, i) => {
      const d = i - s, a = Math.abs(d);
      c.style.transform = `translate3d(${d * 14}%, ${d * -5}%, ${-a * 130}px) rotateY(${d * -16}deg) rotateX(${a * 3}deg)`;
      // The front card is opaque and on top, and only its words are shown: the cards behind keep the stack's depth,
      // but two cards' text never shows through each other mid-transition.
      const front = i === Math.round(s);
      c.style.opacity = front ? 1 : Math.min(1, Math.max(0, 1.2 - a * 1.4));
      c.style.setProperty('--c', front ? 1 : 0);
      c.style.zIndex = front ? 20 : 10 - Math.round(a * 3);
    });
  };
  addEventListener('scroll', render, { passive: true });
  addEventListener('resize', render);
  render();
}

/** The 3D memory constellation loads only when its canvas is about to be seen. */
export function initScene() {
  const canvas = document.querySelector('#scene');
  if (!canvas) return;
  // Phones and data-saver connections skip the 3D scene entirely (it is decoration, and Three.js is the heaviest file on
  // the page). Elsewhere it loads after first paint, when the browser is idle, so the headline is never kept waiting.
  if (innerWidth < 760 || navigator.connection?.saveData) { canvas.remove(); return; }
  const load = () => import('/scene.js').then((m) => m.mountScene(canvas, { reduce })).catch(() => canvas.remove());
  const start = () => ('requestIdleCallback' in window ? requestIdleCallback(load, { timeout: 2500 }) : setTimeout(load, 600));
  if (!('IntersectionObserver' in window)) return start();
  const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) { io.disconnect(); start(); } }, { rootMargin: '200px' });
  io.observe(canvas);
}

/**
 * "Watch a fix teach the system": the four-step journey runs as a continuous loop while it is on screen, and pauses when it is
 * not. With reduced motion it shows the finished journey and does not animate.
 */
export function initJourney() {
  const root = document.querySelector('#journey');
  if (!root) return;
  const nodes = [...root.querySelectorAll('.node')], count = root.querySelector('#j-count'), caption = root.querySelector('#j-caption');
  const words = ['Customer A’s screen flickers. The standard first step does not help.', 'A specialist solves it and writes the fix.', 'Customer A confirms it worked. Memory goes from 0 to 1.', 'Customer B describes the same problem in different words and is helped instantly by A’s verified fix.'];
  const toggle = root.querySelector('#j-toggle');
  const show = (upTo) => {
    nodes.forEach((n, i) => n.classList.toggle('on', i <= upTo));
    count.textContent = upTo >= 2 ? '1' : '0';
    count.classList.toggle('up', upTo >= 2);
    caption.textContent = upTo >= 0 ? words[upTo] : words[0];
  };
  if (reduce || !('IntersectionObserver' in window)) { show(3); toggle?.remove(); return; }
  let visible = false, step = -1, timer = null, paused = false;
  const tick = () => {
    timer = null;
    if (!visible || document.hidden || paused) return;
    // after the last step, hold for a moment, then start again from an empty state
    step = step >= 3 ? -1 : step + 1;
    show(step);
    timer = setTimeout(tick, step === 3 ? 3200 : step === -1 ? 700 : 1700);
  };
  const resume = () => { if (!timer && visible && !document.hidden && !paused) tick(); };
  // WCAG 2.2.2: moving content that lasts more than five seconds can be paused. Pausing shows the finished story.
  toggle?.addEventListener('click', () => {
    paused = !paused;
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.textContent = paused ? 'Play animation' : 'Pause animation';
    if (paused) { clearTimeout(timer); timer = null; show(3); } else { step = -1; resume(); }
  });
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; resume(); }, { threshold: 0.3 }).observe(root);
  document.addEventListener('visibilitychange', resume);
  show(-1);
}

export function initFx() {
  initTheme();
  initProgress();
  initReveal();
  initTilt();
  initStory();
  initScene();
  initJourney();
}
