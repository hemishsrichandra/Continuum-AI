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
    button.textContent = light ? '☾' : '☀';
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
  const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
  items.forEach((el) => io.observe(el));
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
    if (innerWidth <= 900) { steps.forEach((s) => s.classList.add('on')); cards.forEach((c) => { c.style.transform = ''; c.style.opacity = ''; }); return; }
    const r = story.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, -r.top / (story.offsetHeight - innerHeight)));
    const s = p * (cards.length - 1);
    steps.forEach((el, i) => el.classList.toggle('on', Math.round(s) === i));
    cards.forEach((c, i) => {
      const d = i - s, a = Math.abs(d);
      c.style.transform = `translate3d(${d * 14}%, ${d * -5}%, ${-a * 130}px) rotateY(${d * -16}deg) rotateX(${a * 3}deg)`;
      c.style.opacity = Math.max(0, 1 - a * 1.3);
      c.style.zIndex = 10 - Math.round(a * 3);
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
  const start = () => import('/scene.js').then((m) => m.mountScene(canvas, { reduce })).catch(() => canvas.remove());
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
  const words = ['Customer A reports a flickering screen.', 'The standard suggestion fails, so a specialist writes a fix.', 'Customer A confirms it worked. Memory goes from 0 to 1.', 'Customer B reports a similar problem and receives A’s verified fix.'];
  const show = (upTo) => {
    nodes.forEach((n, i) => n.classList.toggle('on', i <= upTo));
    count.textContent = upTo >= 2 ? '1' : '0';
    count.classList.toggle('up', upTo >= 2);
    caption.textContent = upTo >= 0 ? words[upTo] : words[0];
  };
  if (reduce || !('IntersectionObserver' in window)) { show(3); return; }
  let visible = false, step = -1, timer = null;
  const tick = () => {
    timer = null;
    if (!visible || document.hidden) return;
    // after the last step, hold for a moment, then start again from an empty state
    step = step >= 3 ? -1 : step + 1;
    show(step);
    timer = setTimeout(tick, step === 3 ? 3200 : step === -1 ? 700 : 1700);
  };
  const resume = () => { if (!timer && visible && !document.hidden) tick(); };
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
