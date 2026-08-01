const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2',
  'H3', 'H4', 'H5', 'H6', 'HR', 'IMG', 'INPUT', 'LABEL', 'LI', 'OL', 'P', 'PRE',
  'SPAN', 'STRONG', 'U', 'UL',
]);
const ALLOWED_ATTRS = new Set([
  'alt', 'checked', 'class', 'data-checked', 'data-type', 'data-wikilink-id',
  'disabled', 'height', 'href', 'rel', 'src', 'style', 'target', 'title', 'type', 'width',
]);
const SAFE_PROTOCOLS = /^(https?:|mailto:|attachment:|data:image\/(?:gif|jpeg|jpg|png|webp);)/i;

/**
 * Sanitize HTML that may have come from a synced note or an imported backup.
 * TipTap's schema remains the final editor parser, but this boundary prevents
 * scripts, event handlers, and unsafe URLs from reaching rendered previews.
 */
export function sanitizeHtml(html: string): string {
  if (!html || typeof DOMParser === 'undefined') return html || '';
  const document = new DOMParser().parseFromString(html, 'text/html');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  let current = walker.nextNode();
  while (current) {
    elements.push(current as Element);
    current = walker.nextNode();
  }

  for (const element of elements) {
    if (!ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && !SAFE_PROTOCOLS.test(attribute.value.trim())) {
        element.removeAttribute(attribute.name);
      }
      if (name === 'style') {
        const width = attribute.value.match(/(?:^|;)\\s*width\\s*:\\s*(\\d+(?:\\.\\d+)?(?:%|px|em|rem|vw)|auto)\\s*(?:;|$)/i);
        if (width) element.setAttribute('style', `width: ${width[1]}`);
        else element.removeAttribute('style');
      }
    }
    if (element.tagName === 'A') {
      element.setAttribute('rel', 'noopener noreferrer');
      element.setAttribute('target', '_blank');
    }
  }
  return document.body.innerHTML;
}

/** Convert note HTML to safe, compact text for search result previews. */
export function htmlToSnippet(html: string, maxLength = 180): string {
  if (!html) return '';
  if (typeof DOMParser === 'undefined') {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }
  const sanitized = sanitizeHtml(html).replace(
    /<\/(?:p|div|h[1-6]|li|br|blockquote|pre|ul|ol)>/gi,
    ' ',
  );
  const document = new DOMParser().parseFromString(sanitized, 'text/html');
  return (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
