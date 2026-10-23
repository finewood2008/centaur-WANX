// Small DOM event shim for renderer unit tests with multiple delegated listeners.
export function rendererEvents() {
  const listeners = new Map();
  return {
    add(name, callback, capture = false) {
      const rows = listeners.get(name) || [];
      rows.push({ callback, capture: capture === true });
      listeners.set(name, rows);
    },
    get(name) {
      return event => {
        let stopped = false;
        const pending = [];
        event.target ||= {};
        event.target.hasAttribute ||= name => name.startsWith('data-') && Object.hasOwn(event.target.dataset || {}, name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase()));
        event.preventDefault ||= () => {};
        event.stopImmediatePropagation = () => { stopped = true; };
        const closest = event.target?.closest?.bind(event.target);
        if (event.target) event.target.closest = selector => {
          const element = closest ? closest(selector) : null, data = element?.dataset || {};
          if (selector.includes('data-team-action') && !data.teamAction) return null;
          if (selector.includes('data-data-action') && !data.dataAction) return null;
          if (selector.includes('data-data-form') && !data.dataForm) return null;
          if (selector.includes('wanx-mcp-') && !data.action?.startsWith('wanx-mcp-')) return null;
          return element;
        };
        for (const { callback } of [...(listeners.get(name) || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
          const result = callback(event);
          if (result?.then) pending.push(result);
          if (stopped) break;
        }
        return Promise.all(pending);
      };
    },
  };
}
