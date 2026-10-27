import { describe, expect, it } from 'vitest';
import { boundedText } from '~/evidence/text';

function normalized(node: Node): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('boundedText', () => {
  it('matches normalized textContent when the text fits', () => {
    document.body.innerHTML =
      '<div>\n  <span>Save</span>\n  <b>  changes </b><!-- note --><i>now</i>\n</div>';
    const el = document.body.firstElementChild!;
    expect(boundedText(el, 200)).toEqual({ text: normalized(el), truncated: false });
    expect(boundedText(el, 200).text).toBe('Save changes now');
  });

  it('cuts at max and reports the rest', () => {
    document.body.innerHTML = `<ul>${Array.from({ length: 500 }, (_, i) => `<li>item ${i}</li>`).join('')}</ul>`;
    const el = document.body.firstElementChild!;
    const { text, truncated } = boundedText(el, 50);
    expect(truncated).toBe(true);
    expect(text).toBe(normalized(el).slice(0, 50));
  });

  it('is not cut short by long runs of indentation', () => {
    const indent = ' '.repeat(1000);
    document.body.innerHTML = `<div>${indent}<span>${indent}Real text${indent}</span>${indent}</div>`;
    expect(boundedText(document.body.firstElementChild!, 20)).toEqual({ text: 'Real text', truncated: false });
  });

  it('does not count trailing whitespace as more text', () => {
    document.body.innerHTML = `<p>${'a'.repeat(10)}${' '.repeat(500)}</p>`;
    expect(boundedText(document.body.firstElementChild!, 10)).toEqual({ text: 'a'.repeat(10), truncated: false });
  });

  it('reads a text node directly', () => {
    const node = document.createTextNode('  hello   world ');
    expect(boundedText(node, 5)).toEqual({ text: 'hello', truncated: true });
  });

  it('stays within the subtree it was given', () => {
    document.body.innerHTML = '<div><p>inside</p></div><p>outside</p>';
    expect(boundedText(document.body.firstElementChild!, 100).text).toBe('inside');
  });
});
