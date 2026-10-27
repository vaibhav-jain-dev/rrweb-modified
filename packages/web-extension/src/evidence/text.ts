/**
 * Bounded text extraction. `el.textContent` builds the text of the whole
 * subtree, which for a feed, a `role="main"` wrapper or `<html>` itself (the
 * target of every page scroll) is megabytes of string built on the page's
 * main thread just to keep the first few characters. This walks the subtree
 * in the same order and stops once it has enough.
 */

const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function nextInSubtree(node: Node, root: Node): Node | null {
  if (node.firstChild) return node.firstChild;
  let current: Node | null = node;
  while (current && current !== root) {
    if (current.nextSibling) return current.nextSibling;
    current = current.parentNode;
  }
  return null;
}

/**
 * `node.textContent` with whitespace collapsed and trimmed, cut to `max`
 * characters; `truncated` says whether the full text was longer.
 */
export function boundedText(node: Node, max: number): { text: string; truncated: boolean } {
  let buffer = '';
  let done = false;
  // Raw text is collapsed whenever it grows past this, so a long run of
  // indentation can't end the walk before any real text is seen.
  const collapseAt = max * 2 + 64;

  const add = (data: string) => {
    buffer += data;
    if (buffer.length <= collapseAt) return;
    buffer = collapse(buffer).trimStart();
    // Text added later only extends the end, so once the trimmed buffer is
    // past `max` the first `max` characters are final.
    if (buffer.trimEnd().length > max) done = true;
  };

  if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) {
    add((node as CharacterData).data);
  } else {
    let current: Node | null = node.firstChild;
    while (current && !done) {
      if (current.nodeType === TEXT_NODE || current.nodeType === CDATA_SECTION_NODE) {
        add((current as CharacterData).data);
      }
      current = nextInSubtree(current, node);
    }
  }

  const text = collapse(buffer).trim();
  return { text: text.slice(0, max), truncated: text.length > max };
}
