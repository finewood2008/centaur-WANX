import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../local-ui/renderer/store-carousel.js', import.meta.url), 'utf8');

function fixture(reduced = false) {
  const events = new Map(), motionEvents = new Map();
  const document = { hidden: false, activeElement: null, addEventListener: (name, callback) => events.set(name, callback) };
  const motion = { matches: reduced, addEventListener: (name, callback) => motionEvents.set(name, callback) };
  const window = { matchMedia: () => motion };
  vm.runInNewContext(source, { window, document, setTimeout, clearTimeout, queueMicrotask });
  const node = () => ({ attrs: {}, dataset: {}, setAttribute(name, value) { this.attrs[name] = value; }, focus() { document.activeElement = this; } });
  const slides = ['知君', '半人马环', '众见', 'AI 浏览器'].map((name, i) => ({ ...node(), dataset: { name }, offsetLeft: i * 348, offsetWidth: 330 }));
  const viewportHandlers = new Map();
  const viewport = { clientWidth: 900, scrollLeft: 0, scrollTo(options) { this.lastScroll = options; }, addEventListener: (name, callback) => viewportHandlers.set(name, callback) };
  const dots = slides.filter((_, i) => i % 2 === 0).map(node), toggle = node(), caption = node(), handlers = new Map();
  const root = { dataset: {}, matches: () => false, contains: el => dots.includes(el) || el === toggle,
    addEventListener: (name, callback) => handlers.set(name, callback),
    querySelectorAll: selector => selector === '.carousel-slide' ? slides : dots,
    querySelector: selector => selector === '.carousel-viewport' ? viewport : selector === '.carousel-caption' ? caption : toggle,
  };
  const carousel = window.createStoreCarousel();
  carousel.mount(root, true);
  return { carousel, root, slides, dots, toggle, caption, handlers, events, motionEvents, document, viewport, viewportHandlers };
}

test('automatic rotation advances every five seconds and wraps after both two-app pages', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  assert.ok(f.slides.every(slide => !slide.inert));
  t.mock.timers.tick(4999); assert.equal(f.carousel.index, 0);
  t.mock.timers.tick(1); assert.equal(f.root.dataset.active, '1');
  assert.equal(f.caption.textContent, '2 / 2');
  assert.equal(f.dots[1].attrs['aria-current'], 'true');
  assert.ok(f.slides.every(slide => slide.attrs['aria-hidden'] !== 'true'));
  assert.equal(f.viewport.lastScroll.left, 696);
  for (let i = 0; i < 1; i++) t.mock.timers.tick(5000);
  assert.equal(f.carousel.index, 0);
});

test('hover, keyboard focus, background visibility and explicit pause stop autoplay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.handlers.get('mouseenter')(); t.mock.timers.tick(10000); assert.equal(f.carousel.index, 0);
  f.handlers.get('mouseleave')(); t.mock.timers.tick(5000); assert.equal(f.carousel.index, 1);
  f.handlers.get('focusin')(); t.mock.timers.tick(10000); assert.equal(f.carousel.index, 1);
  f.handlers.get('focusout')(); await Promise.resolve();
  f.document.hidden = true; f.events.get('visibilitychange')();
  t.mock.timers.tick(10000); assert.equal(f.carousel.index, 1);
  f.document.hidden = false; f.events.get('visibilitychange')();
  t.mock.timers.tick(5000); assert.equal(f.carousel.index, 0);
  f.carousel.toggle(); t.mock.timers.tick(10000); assert.equal(f.carousel.index, 0);
  assert.equal(f.toggle.attrs['aria-label'], '继续轮播');
  f.carousel.toggle(); t.mock.timers.tick(5000); assert.equal(f.carousel.index, 1);
  f.carousel.mount(null, false); t.mock.timers.tick(10000); assert.equal(f.carousel.index, 1);
});

test('manual arrows wrap and reduced motion starts paused', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(true);
  t.mock.timers.tick(10000); assert.equal(f.carousel.index, 0);
  f.carousel.select(-1); assert.equal(f.carousel.index, 1);
  let prevented = false;
  f.handlers.get('keydown')({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.carousel.index, 0);
  assert.equal(f.document.activeElement, f.dots[0]);
  f.carousel.select(NaN); assert.equal(f.carousel.index, 0);
});

test('state polling does not restart the interval and navigating away stops rotation', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.mock.timers.tick(4000); f.carousel.mount(f.root, true);
  t.mock.timers.tick(1000); assert.equal(f.carousel.index, 1);
  f.carousel.mount(f.root, false); t.mock.timers.tick(10000); assert.equal(f.carousel.index, 1);
  f.carousel.mount(f.root, true); t.mock.timers.tick(5000); assert.equal(f.carousel.index, 0);
  f.motionEvents.get('change')({ matches: true });
  t.mock.timers.tick(10000); assert.equal(f.carousel.index, 0);
});


test('native horizontal scrolling updates selection without snapping back', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const initial = f.viewport.lastScroll;
  f.viewportHandlers.get('wheel')();
  f.viewport.scrollLeft = 696;
  f.viewportHandlers.get('scrollend')();
  assert.equal(f.carousel.index, 1);
  assert.equal(f.caption.textContent, '2 / 2');
  assert.equal(f.viewport.lastScroll, initial);
  f.carousel.select(1);
  assert.equal(f.viewport.lastScroll.left, 696);
  f.carousel.select(2);
  assert.equal(f.carousel.index, 0);
  assert.ok(f.viewport.lastScroll.left <= 0);
});
