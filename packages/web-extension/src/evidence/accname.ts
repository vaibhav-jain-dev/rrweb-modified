/**
 * Pragmatic accessible-name computation. Not a full implementation of the
 * W3C accname spec - covers the cases that matter for correlating "what a
 * screen reader / the AX tree would call this" against visible UI text:
 * aria-labelledby, aria-label, native label association, common native
 * text content (button/link/heading), placeholder, title, alt.
 *
 * Order follows the accname spec's precedence.
 */

export function computeAccessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const doc = el.ownerDocument;
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc?.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return normalize(text);
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return normalize(ariaLabel);

  if (isFormControl(el)) {
    const label = findAssociatedLabel(el);
    if (label) return normalize(label);
  }

  if (el.tagName === 'IMG') {
    const alt = el.getAttribute('alt');
    if (alt?.trim()) return normalize(alt);
  }

  if (['BUTTON', 'A', 'SUMMARY'].includes(el.tagName) || el.getAttribute('role')) {
    const text = el.textContent?.trim();
    if (text) return normalize(text);
  }

  const title = el.getAttribute('title');
  if (title?.trim()) return normalize(title);

  const placeholder = el.getAttribute('placeholder');
  if (placeholder?.trim()) return normalize(placeholder);

  const text = el.textContent?.trim();
  if (text && text.length <= 120) return normalize(text);

  return '';
}

function isFormControl(el: Element): boolean {
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
}

function findAssociatedLabel(el: Element): string | undefined {
  const id = el.id;
  if (id) {
    const label = el.ownerDocument?.querySelector(`label[for=${JSON.stringify(id)}]`);
    if (label?.textContent) return label.textContent.trim();
  }
  const wrappingLabel = el.closest('label');
  if (wrappingLabel?.textContent) return wrappingLabel.textContent.trim();
  return undefined;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Is this node visually and programmatically usable, as best we can tell
 * without a real CDP accessibility-tree cross-check (that layer adds
 * `ax-ignored` on top of this in the background script)?
 */
export function computeVisibility(
  el: Element,
): 'visible-usable' | 'visible-disabled' | 'dom-only-hidden' {
  const rect = el.getBoundingClientRect();
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  const hasSize = rect.width > 0 && rect.height > 0;
  const notClipped = style ? style.overflow !== 'hidden' || hasSize : true;
  const visible =
    hasSize &&
    notClipped &&
    style?.display !== 'none' &&
    style?.visibility !== 'hidden' &&
    style?.opacity !== '0' &&
    el.getAttribute('aria-hidden') !== 'true' &&
    !el.hasAttribute('hidden');

  if (!visible) return 'dom-only-hidden';

  const disabled =
    (el as HTMLInputElement).disabled === true ||
    el.getAttribute('aria-disabled') === 'true';
  return disabled ? 'visible-disabled' : 'visible-usable';
}
