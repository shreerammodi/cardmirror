/**
 * Public API for prosemirror-debate.
 *
 * Three layers:
 *   - Schema:   the ProseMirror schema (typed-tree document model).
 *   - Import:   .docx → schema doc.
 *   - Export:   schema doc → .docx.
 */

export {
  schema,
  nodes,
  marks,
  newHeadingId,
  bookmarkNameForId,
  idFromBookmarkName,
  HEADING_BOOKMARK_PREFIX,
} from './schema/index.js';

export { fromDocx, fromDocxFull, importDoc, importComments } from './import/index.js';

export { toDocx, exportDoc } from './export/index.js';
export type { ExportResult, ExportOptions } from './export/index.js';

export { Docx } from './ooxml/docx.js';
