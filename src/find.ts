// Find-in-page for the Adminer iframe (same origin) — the browser's Ctrl+F equivalent.
// Matches are painted with the CSS Custom Highlight API (page DOM is untouched);
// without that API only the current match is shown via Selection.

const HL_ALL = "adrix-find";
const HL_CUR = "adrix-find-cur";
const MAX_MATCHES = 20000;
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "OPTION", "SELECT", "TEMPLATE"]);

type HighlightCtor = new (...ranges: Range[]) => unknown;
interface HighlightWin {
  Highlight?: HighlightCtor;
  CSS?: { highlights?: Map<string, unknown> };
}

export interface FindResult {
  count: number;
  index: number; // 0-based, -1 = no matches
  capped: boolean;
}

export class Finder {
  private ranges: Range[] = [];
  private index = -1;
  private query = "";
  private doc: Document | null = null;

  /** New document (iframe navigation); results are recomputed while the bar is open. */
  attach(doc: Document | null): void {
    this.doc = doc;
    this.ranges = [];
    this.index = -1;
    if (doc) ensureStyle(doc);
  }

  search(query: string, keepPosition = false): FindResult {
    const prevIndex = this.index;
    this.query = query;
    this.ranges = query && this.doc ? collect(this.doc, query) : [];
    this.index = this.ranges.length ? (keepPosition ? Math.min(Math.max(prevIndex, 0), this.ranges.length - 1) : this.firstVisible()) : -1;
    this.paint(true);
    return this.result();
  }

  /** Re-run the search (after navigation/reload). */
  refresh(): FindResult {
    return this.search(this.query, true);
  }

  step(dir: 1 | -1): FindResult {
    if (!this.ranges.length) return this.result();
    this.index = (this.index + dir + this.ranges.length) % this.ranges.length;
    this.paint(true);
    return this.result();
  }

  clear(): void {
    this.ranges = [];
    this.index = -1;
    this.paint(false);
  }

  private result(): FindResult {
    return { count: this.ranges.length, index: this.index, capped: this.ranges.length >= MAX_MATCHES };
  }

  /** First match in or below the viewport — like browsers do. */
  private firstVisible(): number {
    for (let i = 0; i < this.ranges.length; i++) {
      if (this.ranges[i].getBoundingClientRect().bottom >= 0) return i;
    }
    return 0;
  }

  private paint(scroll: boolean): void {
    const doc = this.doc;
    if (!doc) return;
    const win = doc.defaultView as (Window & HighlightWin) | null;
    const registry = win?.CSS?.highlights;
    const cur = this.ranges[this.index];

    if (registry && win?.Highlight) {
      registry.delete(HL_ALL);
      registry.delete(HL_CUR);
      if (this.ranges.length) registry.set(HL_ALL, new win.Highlight(...this.ranges));
      if (cur) registry.set(HL_CUR, new win.Highlight(cur));
    } else if (cur) {
      const sel = doc.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(cur);
    }

    if (scroll && cur) {
      const el = cur.startContainer.parentElement;
      el?.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById("adrix-find-style")) return;
  const style = doc.createElement("style");
  style.id = "adrix-find-style";
  style.textContent =
    `::highlight(${HL_ALL}){background-color:#ffe066;color:#111}` +
    `::highlight(${HL_CUR}){background-color:#ff8c1a;color:#111}`;
  (doc.head ?? doc.documentElement).append(style);
}

function collect(doc: Document, query: string): Range[] {
  const needle = query.toLocaleLowerCase();
  const visible = new WeakMap<Element, boolean>();
  const isVisible = (el: Element): boolean => {
    let v = visible.get(el);
    if (v === undefined) {
      v = typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
      visible.set(el, v);
    }
    return v;
  };

  const ranges: Range[] = [];
  const root = doc.body ?? doc.documentElement;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || node.nodeValue.length < needle.length) return NodeFilter.FILTER_REJECT;
      return isVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue!;
    const hay = text.toLocaleLowerCase();
    if (hay.length !== text.length) continue; // rare chars whose length changes when lowercased
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      const r = doc.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + needle.length);
      ranges.push(r);
      if (ranges.length >= MAX_MATCHES) return ranges;
    }
  }
  return ranges;
}
