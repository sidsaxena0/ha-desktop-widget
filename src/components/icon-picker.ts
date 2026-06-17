// A searchable picker over the full Material Design Icons set. Opens as a
// modal; calls onPick with an `mdi:<name>` string. Results are capped per
// render so the grid stays snappy even though the set is ~7,400 icons.

import { MDI_NAMES } from "../vendor/mdi-names";
import { el } from "../util";

const CAP = 300;

export function openIconPicker(current: string, onPick: (icon: string) => void): void {
  const cur = current.startsWith("mdi:") ? current.slice(4) : "";

  const backdrop = el("div", { class: "sheet-backdrop" });
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  const sheet = el("div", { class: "sheet picker" });
  const head = el("div", { class: "sheet-head" });
  head.innerHTML = `<div class="sheet-title">Choose an icon</div>`;
  const x = el("button", { class: "act", html: `<i class="mdi mdi-close" aria-hidden="true"></i>` });
  x.addEventListener("click", close);
  head.appendChild(x);
  sheet.appendChild(head);

  const search = el("input", { class: "picker-search", attrs: { type: "text", placeholder: "Search icons…" } });
  const hint = el("div", { class: "picker-hint" });
  const grid = el("div", { class: "picker-grid" });
  sheet.append(search, hint, grid);

  const render = (q: string) => {
    const query = q.trim().toLowerCase();
    const matches = query ? MDI_NAMES.filter((n) => n.includes(query)) : MDI_NAMES;
    const shown = matches.slice(0, CAP);
    const frag = document.createDocumentFragment();
    for (const name of shown) {
      const b = el("button", {
        class: `pick-ico ${name === cur ? "active" : ""}`,
        html: `<i class="mdi mdi-${name}" aria-hidden="true"></i>`,
        attrs: { title: name },
      });
      b.addEventListener("click", () => {
        onPick(`mdi:${name}`);
        close();
      });
      frag.appendChild(b);
    }
    grid.replaceChildren(frag);
    hint.textContent =
      matches.length > CAP
        ? `Showing ${CAP} of ${matches.length} — type to narrow`
        : `${matches.length} icon${matches.length === 1 ? "" : "s"}`;
  };

  search.addEventListener("input", () => render(search.value));
  render("");

  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);
  setTimeout(() => search.focus(), 30);
}
