// Keep the task editor stable across the Host renderer's full-page refreshes.
window.createStudioInputRetention = function(root, changed) {
  let composition = null;
  const selector = '[data-studio-edit-key]';
  const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  root.addEventListener('compositionstart', event => {
    if (event.target.matches?.(selector)) composition = event.target;
  });
  root.addEventListener('compositionend', event => {
    if (composition !== event.target) return;
    composition = null;
    // Chromium sends the committed input after compositionend.
    setTimeout(changed, 0);
  });
  return {
    defer(markup) {
      if (!composition?.isConnected) { composition = null; return false; }
      return markup.includes('data-studio-edit-key="'+escape(composition.dataset.studioEditKey)+'"');
    },
    capture() {
      const owner=root.ownerDocument||(typeof document==='undefined'?null:document);
      // Chromium's state-preserving move keeps a read-only iframe alive through
      // a Host redraw. The frame key includes the private runtime handle.
      const frames=Array.from(root.querySelectorAll?.('[data-studio-frame-key]')||[]);
      const parking=frames.length&&owner?.body?.moveBefore?owner.createElement('div'):null;
      if(parking){parking.hidden=true;owner.body.append(parking);for(const node of frames)parking.moveBefore(node,null)}
      const restoreFrames=()=>{if(!parking)return;for(const node of frames){const next=Array.from(root.querySelectorAll?.('[data-studio-frame-key]')||[]).find(n=>n.dataset.studioFrameKey===node.dataset.studioFrameKey);if(next?.parentElement?.moveBefore){next.parentElement.moveBefore(node,next);next.remove()}}parking.remove()};
      const scrollers=Array.from(root.querySelectorAll?.('[data-studio-scroll-key]')||[]).map(node=>({key:node.dataset.studioScrollKey,top:node.scrollTop}));
      const menus = Array.from(root.querySelectorAll?.('[data-studio-menu-key]') || []).map(node => ({
        node, focused: node.contains?.(owner?.activeElement) ? owner?.activeElement : null,
      }));
      const restoreMenus = () => {
        restoreFrames();
        for(const saved of scrollers){const next=Array.from(root.querySelectorAll?.('[data-studio-scroll-key]')||[]).find(n=>n.dataset.studioScrollKey===saved.key);if(next)next.scrollTop=saved.top}
        for (const {node, focused} of menus) {
          const next = Array.from(root.querySelectorAll?.('[data-studio-menu-key]') || []).find(item => item.dataset.studioMenuKey === node.dataset.studioMenuKey);
          // Keep the clicked summary connected through a pending Host redraw;
          // its native toggle, open state and keyboard focus must survive it.
          if (!next || node.innerHTML !== next.innerHTML) continue;
          next.replaceWith(node);
          if (focused?.isConnected) focused.focus({preventScroll:true});
        }
      };
      const active=owner?.activeElement;
      const node = active?.matches?.(selector)?active:root.querySelector(selector);
      if (!node?.dataset?.studioEditKey) return restoreMenus;
      const focused = owner?.activeElement === node;
      const selection = [node.selectionStart, node.selectionEnd, node.selectionDirection];
      const scroll = node.scrollTop;
      return () => {
        restoreMenus();
        const next=Array.from(root.querySelectorAll?.(selector)||[]).find(n=>n.dataset.studioEditKey===node.dataset.studioEditKey)||root.querySelector(selector);
        if (!next || next.dataset.studioEditKey !== node.dataset.studioEditKey) return;
        const unchanged = next.value === node.value;
        node.disabled = next.disabled;
        node.readOnly = next.readOnly;
        node.placeholder = next.placeholder;
        if (!unchanged) node.value = next.value;
        next.replaceWith(node);
        if (focused && !node.disabled) {
          node.focus({preventScroll:true});
          if (unchanged && typeof node.setSelectionRange==='function') node.setSelectionRange(...selection);
        }
        node.scrollTop = scroll;
      };
    },
  };
};
