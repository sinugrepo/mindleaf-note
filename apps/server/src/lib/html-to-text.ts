/**
 * Strip HTML tags from TipTap editor content to produce the plaintext
 * payload the search index (Phase 6) feeds into `to_tsvector('simple',
 * title || ' ' || plaintext)`.
 *
 * Why server-side:
 *   - The content body is AES-256-GCM encrypted on disk (`content_ct` /
 *     `content_nonce`). Only the application layer can decrypt it prior
 *     to indexing; Postgres has no key, so a `GENERATED` column or
 *     trigger-based FTS is not an option.
 *
 * Why not a heavy library:
 *   - The TipTap editor produces a small, well-known subset of HTML
 *     (headings, paragraphs, lists, links, <img>, spans with custom
 *     attrs). A regex-based stripper handles that subset adequately and
 *     avoids a `sanitize-html` / `htmlparser2` dependency in the
 *     backend bundle.
 *
 * Limitations:
 *   - We do NOT decode every HTML entity (only the common five — &
 *     < > " '). Uncommon entities (e.g. `&hellip;`) drop through as
 *     their literal `&...;` text. Acceptable for search ranking — a
 *     literal "hellip" is fine for a typo-tolerant user query.
 *   - We do NOT preserve inline code-block, table, or list structure
 *     for indexing. That's fine: tsvector tokenization doesn't care.
 *   - Style/class attributes and `data-*` attrs are silently dropped.
 */
export function htmlToPlaintext(html: string | null | undefined): string {
  if (!html) return '';
  // Strip the tag itself. Greedy with non-greedy inner: <...> without
  // crossing over nested >. Adequate for the TipTap subset.
  let text = html.replace(/<\/?[^>]+(>|$)/g, ' ');
  // Decode the common named entities & numeric ones.
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    // Numeric character references: &#NNN; and &#xHH;
    .replace(/&#(\d+);/g, (_m, code: string) =>
      String.fromCharCode(parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) =>
      String.fromCharCode(parseInt(code, 16)),
    );
  // Collapse all whitespace runs (incl. the spaces we inserted between
  // dropped tags) into single spaces.
  return text.replace(/\s+/g, ' ').trim();
}
