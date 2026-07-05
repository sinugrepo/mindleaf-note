import { Mark, mergeAttributes } from '@tiptap/core';
import { WIKILINK_ID_ATTR } from '../lib/wikilink';

/**
 * TipTap mark representing an inline wiki-style link.
 *
 * Serialized as `<span data-wikilink-id="<target-note-id>">label</span>`.
 * Click handling is wired separately in Editor.tsx via the editor's
 * `editorProps.handleClick` callback, which intercepts clicks on
 * `[data-wikilink-id]` spans and dispatches a navigation callback.
 *
 * Why a mark and not a node:
 *  - inline-friendly: `before [[Foo]] after` keeps the wikilink
 *    inside the same paragraph,
 *  - schema queries (`editor.state.doc`) for `markType(name)` are cheap,
 *  - the panel scanner (extractBacklinkedNoteIds) needs a single regex
 *    over the rendered HTML and the span wrapper provides that.
 *
 * `inclusive: false` so the mark does NOT extend across typed text —
 * hitting Space or any printable key after the link ends the mark
 * cleanly. The user can still cursor into the mark to retype the
 * label; the convention is that the autocomplete inserts the canonical
 * title so manual edits are rare.
 *
 * The Mark type is exported so other parts of the codebase can refer
 * to `wikiLink` by name when reading from `editor.state.doc`.
 */
export const WikiLink = Mark.create({
  name: 'wikiLink',
  inclusive: false,
  exitable: true,

  addAttributes() {
    return {
      targetId: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute(WIKILINK_ID_ATTR) ?? null,
        renderHTML: (attributes) => {
          if (!attributes.targetId) return {};
          return { [WIKILINK_ID_ATTR]: attributes.targetId };
        },
      },
      label: {
        // Label is stored in the mark for round-tripping and easy
        // inspection; we don't write it as an HTML attribute because
        // it's already the span's innerText, and TipTap's renderHTML
        // emits the inner text verbatim (via the trailing `0`).
        default: '',
        parseHTML: (element) => element.textContent ?? '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[${WIKILINK_ID_ATTR}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'wikilink' }),
      0,
    ];
  },
});
