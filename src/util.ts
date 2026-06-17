// Small DOM/string helpers shared across components.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Rate-limit a function (trailing-edge) — used so slider drags don't flood HA. */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    const now = Date.now();
    const elapsed = now - last;
    if (elapsed >= ms) {
      last = now;
      fn(...args);
    } else {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, ms - elapsed);
    }
  };
}

/** Create an element with optional class, text, and attributes. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: {
    class?: string;
    text?: string;
    html?: string;
    attrs?: Record<string, string>;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.html !== undefined) node.innerHTML = opts.html;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  return node;
}
