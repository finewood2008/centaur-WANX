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
      const menus = Array.from(root.querySelectorAll?.('[data-studio-menu-key]') || []).map(node => ({
        node, focused: node.contains?.(root.ownerDocument.activeElement) ? root.ownerDocument.activeElement : null,
      }));
      const restoreMenus = () => {
        for (const {node, focused} of menus) {
          const next = Array.from(root.querySelectorAll?.('[data-studio-menu-key]') || []).find(item => item.dataset.studioMenuKey === node.dataset.studioMenuKey);
          // Keep the clicked summary connected through a pending Host redraw;
          // its native toggle, open state and keyboard focus must survive it.
          if (!next || node.innerHTML !== next.innerHTML) continue;
          next.replaceWith(node);
          if (focused?.isConnected) focused.focus({preventScroll:true});
        }
      };
      const node = root.querySelector(selector);
      if (!node) return restoreMenus;
      const focused = root.ownerDocument.activeElement === node;
      const selection = [node.selectionStart, node.selectionEnd, node.selectionDirection];
      const scroll = node.scrollTop;
      return () => {
        restoreMenus();
        const next = root.querySelector(selector);
        if (!next || next.dataset.studioEditKey !== node.dataset.studioEditKey) return;
        const unchanged = next.value === node.value;
        node.disabled = next.disabled;
        node.readOnly = next.readOnly;
        node.placeholder = next.placeholder;
        if (!unchanged) node.value = next.value;
        next.replaceWith(node);
        if (focused && !node.disabled) {
          node.focus({preventScroll:true});
          if (unchanged) node.setSelectionRange(...selection);
        }
        node.scrollTop = scroll;
      };
    },
  };
};
