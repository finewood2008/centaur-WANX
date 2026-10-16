// Local presentation only: no application launch, installation or network actions.
window.createStoreCarousel = () => {
  let root = null, enabled = false, timer = null, index = 0;
  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let paused = motion?.matches || false, hovered = false, focused = false;
  const clear = () => { clearTimeout(timer); timer = null; };
  const count = () => Math.ceil((root?.querySelectorAll('.carousel-slide').length || 0) / 2);
  const canPlay = () => enabled && root && count() > 1 && !paused && !hovered && !focused && !document.hidden;
  function paint(scroll = false) {
    if (!root) return;
    root.dataset.active = String(index);
    // Multiple cards are visible together; every card stays keyboard accessible.
    if (scroll) {
      const viewport = root.querySelector('.carousel-viewport');
      const slides = root.querySelectorAll('.carousel-slide');
      if (viewport && slides[index * 2]) viewport.scrollTo({
        left: slides[index * 2].offsetLeft - slides[0].offsetLeft,
        behavior: motion?.matches ? 'instant' : 'smooth',
      });
    }
    root.querySelectorAll('.carousel-dot').forEach((dot, position) => dot.setAttribute('aria-current', String(position === index)));
    const toggle = root.querySelector('[data-action="carousel-toggle"]');
    if (toggle) {
      toggle.setAttribute('aria-label', paused ? '继续轮播' : '暂停轮播');
      toggle.setAttribute('aria-pressed', String(paused));
      toggle.textContent = paused ? '▶' : 'Ⅱ';
    }
    const caption = root.querySelector('.carousel-caption');
    if (caption) caption.textContent = `${index + 1} / ${count()}`;
  }
  function schedule() {
    if (!canPlay()) { clear(); return; }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (canPlay()) { index = (index + 1) % count(); paint(true); schedule(); }
    }, 5000);
    timer?.unref?.();
  }
  const api = {
    get index() { return index; },
    get paused() { return paused; },
    select(next) {
      if (!count() || !Number.isInteger(next)) return;
      index = (next % count() + count()) % count();
      clear(); paint(true); schedule();
    },
    toggle() { paused = !paused; paint(); schedule(); },
    mount(nextRoot, active) {
      enabled = active;
      if (nextRoot !== root) {
        clear(); root = nextRoot;
        hovered = root?.matches?.(':hover') || false;
        focused = root?.contains?.(document.activeElement) || false;
        if (root) {
          root.addEventListener('mouseenter', () => { hovered = true; schedule(); });
          root.addEventListener('mouseleave', () => { hovered = false; schedule(); });
          root.addEventListener('focusin', () => { focused = true; schedule(); });
          root.addEventListener('focusout', () => queueMicrotask(() => { focused = root?.contains?.(document.activeElement) || false; schedule(); }));
          root.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault(); api.select(index + (event.key === 'ArrowRight' ? 1 : -1));
            root.querySelectorAll('.carousel-dot')[index]?.focus();
          });
          const viewport = root.querySelector('.carousel-viewport');
          let manualScroll = false;
          viewport?.addEventListener('wheel', () => { manualScroll = true; }, { passive: true });
          viewport?.addEventListener('touchstart', () => { manualScroll = true; }, { passive: true });
          viewport?.addEventListener('scrollend', () => {
            if (!manualScroll) return;
            manualScroll = false;
            const slides = [...root.querySelectorAll('.carousel-slide')].filter((_, position) => position % 2 === 0);
            index = slides.reduce((best, slide, position) => {
              const distance = item => Math.abs(item.offsetLeft - slides[0].offsetLeft - viewport.scrollLeft);
              return distance(slide) < distance(slides[best]) ? position : best;
            }, 0);
            clear(); paint(); schedule();
          });
          index %= count() || 1;
          paint(true);
        }
      }
      schedule();
    },
  };
  document.addEventListener('visibilitychange', schedule);
  motion?.addEventListener?.('change', event => { if (event.matches) paused = true; paint(); schedule(); });
  return api;
};
