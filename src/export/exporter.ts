/**
 * Schema → OOXML exporter.
 *
 * Walks a ProseMirror doc and emits a valid `word/document.xml` plus the
 * matching `word/_rels/document.xml.rels` (collecting hyperlink relationships
 * along the way).
 *
 * Round-trip contract per ARCHITECTURE.md §3:
 *   - Schema-typed structure → canonical Verbatim style references.
 *   - Direct-formatting marks → run/paragraph properties.
 *   - Stable heading IDs → `pmd-heading-<uuid>` bookmarks bracketing the heading paragraph.
 */

import type { Mark, Node as PMNode } from 'prosemirror-model';
import {
  el,
  emptyEl,
  escText,
  XML_PROLOG,
} from '../ooxml/xml.js';
import {
  MARK_TO_RSTYLE,
  NODE_TO_PSTYLE,
} from '../ooxml/styles.js';
import { bookmarkNameForId } from '../schema/ids.js';
import { base64ToBytes } from '../ooxml/base64.js';

interface HyperlinkRel {
  rId: string;
  target: string;
}

interface ImageRel {
  rId: string;
  target: string;
}

/** A binary part the exporter wants written into the docx zip. */
export interface ExportedMediaPart {
  /** Full zip path, e.g. `word/media/image1.png`. */
  path: string;
  bytes: Uint8Array;
}

export interface ExportResult {
  /** `word/document.xml` content. */
  documentXml: string;
  /** `word/_rels/document.xml.rels` content. */
  relsXml: string;
  /** Image / binary parts that the docx zip writer must include. */
  mediaParts: ExportedMediaPart[];
}

/** Map common image MIME types to file extensions. */
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf',
};

const DOCUMENT_OPEN = `${XML_PROLOG}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"><w:body>`;

const SECT_PR_AND_DOCUMENT_CLOSE = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

const RELS_OPEN = `${XML_PROLOG}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
const RELS_CLOSE = '</Relationships>';

/**
 * Heading-level node types that get a `pmd-heading-<uuid>` bookmark on
 * export (per ARCHITECTURE.md §4 stable heading IDs).
 */
const HEADING_LIKE = new Set(['pocket', 'hat', 'block', 'tag', 'analytic']);

/** Schema container nodes whose children we emit at the parent level. */
const TRANSPARENT_CONTAINERS = new Set([
  'doc',
  'card',
  'analytic_unit',
]);

class DocxExporter {
  private parts: string[] = [];
  private bookmarkCounter = 0;
  private rels: HyperlinkRel[] = [];
  private imageRels: ImageRel[] = [];
  private mediaParts: ExportedMediaPart[] = [];
  private nextRelId = 2; // rId1 is reserved for styles
  private nextImageIdx = 1;
  private nextDocPrId = 1;

  exportDoc(doc: PMNode): ExportResult {
    if (doc.type.name !== 'doc') {
      throw new Error(`Expected doc node, got ${doc.type.name}`);
    }

    this.parts.push(DOCUMENT_OPEN);
    this.emitChildren(doc);
    this.parts.push(SECT_PR_AND_DOCUMENT_CLOSE);

    return {
      documentXml: this.parts.join(''),
      relsXml: this.buildRelsXml(),
      mediaParts: this.mediaParts,
    };
  }

  private emitChildren(node: PMNode): void {
    node.forEach((child) => this.emitBlock(child));
  }

  private emitBlock(node: PMNode): void {
    if (TRANSPARENT_CONTAINERS.has(node.type.name)) {
      this.emitChildren(node);
      return;
    }
    if (node.type.name === 'table') {
      this.emitTable(node);
      return;
    }
    // Every other block-level node is a paragraph kind.
    this.emitParagraph(node);
  }

  /**
   * Emit `<w:tbl>` for a `table` node. Cells with `rowspan > 1` are
   * split into a "restart" cell at the top + N-1 "continue" cells
   * (`<w:vMerge/>`) synthesized in the subsequent rows at the same
   * column position. This is the inverse of the importer's vMerge
   * collapse. Empty continuation cells get an empty paragraph for
   * OOXML structural validity.
   *
   * Column placement: PM rows store cells in document order without
   * gaps, but OOXML rows include vMerge continuation cells at their
   * inherited-from-above column positions. We compute each PM cell's
   * effective grid column by skipping over positions occupied by a
   * vMerge from a previous row.
   */
  private emitTable(table: PMNode): void {
    type CellAtCol = { node: PMNode; col: number };
    const rows: CellAtCol[][] = [];
    // `occupied[rowIdx]` is the set of grid columns claimed by a
    // vertical span originating in an earlier row.
    const occupied: Set<number>[] = [];
    let rowIdx = 0;
    table.forEach((row) => {
      if (row.type.name !== 'table_row') return;
      const cells: CellAtCol[] = [];
      let col = 0;
      const myOccupied = occupied[rowIdx] ?? new Set<number>();
      row.forEach((cell) => {
        if (cell.type.name !== 'table_cell' && cell.type.name !== 'table_header') return;
        // Advance past columns claimed by a vMerge from above.
        while (myOccupied.has(col)) col++;
        cells.push({ node: cell, col });
        const cs = Number(cell.attrs['colspan'] ?? 1);
        const rs = Number(cell.attrs['rowspan'] ?? 1);
        // Reserve every column this cell spans for every row it
        // spans below this one.
        for (let r = 1; r < rs; r++) {
          const target = rowIdx + r;
          if (!occupied[target]) occupied[target] = new Set<number>();
          for (let c = 0; c < cs; c++) occupied[target]!.add(col + c);
        }
        col += cs;
      });
      rows.push(cells);
      rowIdx++;
    });

    // Build per-row continuation entries (one for each cell with
    // rowspan > 1, repeated rs-1 times in the rows below).
    type Cont = { col: number; colspan: number };
    const continuationsByRow: Cont[][] = rows.map(() => []);
    rows.forEach((rowCells, rIdx) => {
      for (const c of rowCells) {
        const rs = Number(c.node.attrs['rowspan'] ?? 1);
        const cs = Number(c.node.attrs['colspan'] ?? 1);
        for (let r = 1; r < rs; r++) {
          const target = rIdx + r;
          if (target < continuationsByRow.length) {
            continuationsByRow[target]!.push({ col: c.col, colspan: cs });
          }
        }
      }
    });

    // Determine number of columns from the widest row's right edge
    // (including continuations) so we can emit a minimal `<w:tblGrid>`.
    let colCount = 0;
    rows.forEach((cells, rIdx) => {
      let rightEdge = 0;
      for (const c of cells) {
        const r = c.col + Number(c.node.attrs['colspan'] ?? 1);
        if (r > rightEdge) rightEdge = r;
      }
      for (const k of continuationsByRow[rIdx] ?? []) {
        const r = k.col + k.colspan;
        if (r > rightEdge) rightEdge = r;
      }
      if (rightEdge > colCount) colCount = rightEdge;
    });
    if (colCount === 0) colCount = 1;

    this.parts.push('<w:tbl>');
    this.parts.push(
      '<w:tblPr>' +
        '<w:tblStyle w:val="TableGrid"/>' +
        '<w:tblW w:w="0" w:type="auto"/>' +
        '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
        '</w:tblPr>',
    );
    // Minimal grid: even-width columns, summing to a default
    // total. Word recomputes widths on open if it likes.
    const colWidth = Math.floor(9350 / colCount);
    let grid = '<w:tblGrid>';
    for (let i = 0; i < colCount; i++) grid += `<w:gridCol w:w="${colWidth}"/>`;
    grid += '</w:tblGrid>';
    this.parts.push(grid);

    rows.forEach((rowCells, rowIdx) => {
      this.parts.push('<w:tr>');
      // Build an ordered emission list combining the row's real
      // cells and any vMerge continuation cells that belong here.
      type Entry =
        | { kind: 'real'; node: PMNode; col: number }
        | { kind: 'continue'; col: number; colspan: number };
      const entries: Entry[] = [];
      for (const c of rowCells) entries.push({ kind: 'real', node: c.node, col: c.col });
      for (const k of continuationsByRow[rowIdx] ?? []) {
        entries.push({ kind: 'continue', col: k.col, colspan: k.colspan });
      }
      entries.sort((a, b) => a.col - b.col);

      for (const e of entries) {
        if (e.kind === 'real') {
          const cs = Number(e.node.attrs['colspan'] ?? 1);
          const rs = Number(e.node.attrs['rowspan'] ?? 1);
          this.parts.push('<w:tc>');
          let tcPr = '';
          if (cs > 1) tcPr += `<w:gridSpan w:val="${cs}"/>`;
          if (rs > 1) tcPr += '<w:vMerge w:val="restart"/>';
          this.parts.push(`<w:tcPr><w:tcW w:w="${colWidth * cs}" w:type="dxa"/>${tcPr}</w:tcPr>`);
          e.node.forEach((child) => {
            if (child.type.name === 'paragraph') {
              this.emitParagraph(child);
            } else {
              this.emitBlock(child);
            }
          });
          this.parts.push('</w:tc>');
        } else {
          // Continuation cell. Empty paragraph + <w:vMerge/>.
          this.parts.push('<w:tc>');
          let tcPr = '';
          if (e.colspan > 1) tcPr += `<w:gridSpan w:val="${e.colspan}"/>`;
          tcPr += '<w:vMerge/>';
          this.parts.push(`<w:tcPr><w:tcW w:w="${colWidth * e.colspan}" w:type="dxa"/>${tcPr}</w:tcPr>`);
          this.parts.push('<w:p/>');
          this.parts.push('</w:tc>');
        }
      }
      this.parts.push('</w:tr>');
    });

    this.parts.push('</w:tbl>');
  }

  private emitParagraph(node: PMNode): void {
    const { name } = node.type;
    const pStyle = NODE_TO_PSTYLE[name] ?? null;
    const isHeading = HEADING_LIKE.has(name);
    const id = isHeading ? ((node.attrs['id'] as string | null) ?? null) : null;
    const alignment = (node.attrs['alignment'] as string | null) ?? null;

    let pPrInner = '';
    if (pStyle) pPrInner += `<w:pStyle w:val="${pStyle}"/>`;
    if (alignment) pPrInner += `<w:jc w:val="${alignment}"/>`;
    const pPr = pPrInner ? `<w:pPr>${pPrInner}</w:pPr>` : '';

    this.parts.push('<w:p>');
    this.parts.push(pPr);

    if (id) {
      const wId = this.bookmarkCounter++;
      this.parts.push(emptyEl('w:bookmarkStart', { 'w:id': wId, 'w:name': bookmarkNameForId(id) }));
      this.emitInlines(node);
      this.parts.push(emptyEl('w:bookmarkEnd', { 'w:id': wId }));
    } else {
      this.emitInlines(node);
    }

    this.parts.push('</w:p>');
  }

  private emitInlines(paragraph: PMNode): void {
    paragraph.forEach((child) => {
      if (child.isText) {
        this.emitTextRun(child.text ?? '', child.marks);
      } else if (child.type.name === 'image') {
        this.emitImageRun(child);
      }
      // Other inline non-text nodes: defensive no-op.
    });
  }

  private emitImageRun(node: PMNode): void {
    const data = String(node.attrs['data'] ?? '');
    if (!data) return;
    const contentType = String(node.attrs['contentType'] ?? 'image/png');
    const widthEmu = Math.max(0, Math.round(Number(node.attrs['widthEmu'] ?? 0)));
    const heightEmu = Math.max(0, Math.round(Number(node.attrs['heightEmu'] ?? 0)));
    const alt = String(node.attrs['alt'] ?? '');

    // Generate the media part (binary write into the zip).
    const ext = CONTENT_TYPE_EXTENSIONS[contentType] ?? 'bin';
    const idx = this.nextImageIdx++;
    const filename = `image${idx}.${ext}`;
    const target = `media/${filename}`;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(data);
    } catch {
      return;
    }
    this.mediaParts.push({ path: `word/${target}`, bytes });

    // Register an image relationship.
    const rId = this.registerImage(target);

    // EMU dimensions: prefer provided; otherwise pick a sensible default
    // (a 4-inch / 384-pixel-equivalent box) so Word doesn't render at 0×0.
    const cx = widthEmu > 0 ? widthEmu : 3657600;
    const cy = heightEmu > 0 ? heightEmu : 2743200;

    const docPrId = this.nextDocPrId++;
    const drawing = buildDrawingXml({ rId, cx, cy, docPrId, alt });
    this.parts.push(`<w:r>${drawing}</w:r>`);
  }

  private registerImage(target: string): string {
    const rId = `rId${this.nextRelId++}`;
    this.imageRels.push({ rId, target });
    return rId;
  }

  private emitTextRun(text: string, marks: readonly Mark[]): void {
    if (text.length === 0) return;

    const linkMark = marks.find((m) => m.type.name === 'link');
    const otherMarks = linkMark ? marks.filter((m) => m !== linkMark) : marks;

    const run = `<w:r>${this.rPrFromMarks(otherMarks)}<w:t xml:space="preserve">${escText(text)}</w:t></w:r>`;

    if (linkMark) {
      const href = String(linkMark.attrs['href'] ?? '');
      const rId = this.registerHyperlink(href);
      this.parts.push(`<w:hyperlink r:id="${rId}" w:history="1">${run}</w:hyperlink>`);
    } else {
      this.parts.push(run);
    }
  }

  /** Compose <w:rPr>...</w:rPr> from a set of marks. */
  private rPrFromMarks(marks: readonly Mark[]): string {
    if (marks.length === 0) return '';
    const props: string[] = [];

    // Order matters for some validators. Word's typical ordering:
    // rStyle, rFonts, b, bCs, i, iCs, color, sz, szCs, u, highlight, shd, ...

    const rStyleMark = marks.find((m) => m.type.name in MARK_TO_RSTYLE);
    if (rStyleMark) {
      const styleId = MARK_TO_RSTYLE[rStyleMark.type.name];
      if (styleId) props.push(emptyEl('w:rStyle', { 'w:val': styleId }));
    }

    const fontFamilyMark = marks.find((m) => m.type.name === 'font_family');
    if (fontFamilyMark) {
      const name = String(fontFamilyMark.attrs['name'] ?? '');
      if (name) {
        // Set ascii / hAnsi / cs to the same value. East Asian and
        // other script-specific attributes are uncommon in debate docs;
        // we omit them and let Word fall back to its defaults.
        props.push(emptyEl('w:rFonts', {
          'w:ascii': name,
          'w:hAnsi': name,
          'w:cs': name,
        }));
      }
    }

    if (marks.some((m) => m.type.name === 'bold')) {
      props.push('<w:b/>');
    }
    if (marks.some((m) => m.type.name === 'italic')) {
      props.push('<w:i/>');
      props.push('<w:iCs/>');
    }
    if (marks.some((m) => m.type.name === 'strikethrough')) {
      props.push('<w:strike/>');
    }

    // undertag_mark style implies italic display; emit italic for parity
    // (per DECISIONS.md: dual-encoding precedent set by underline_mark).
    if (marks.some((m) => m.type.name === 'undertag_mark') &&
        !marks.some((m) => m.type.name === 'italic')) {
      props.push('<w:i/>');
      props.push('<w:iCs/>');
    }

    const colorMark = marks.find((m) => m.type.name === 'font_color');
    if (colorMark) {
      const c = String(colorMark.attrs['color'] ?? '000000');
      props.push(emptyEl('w:color', { 'w:val': c }));
    }

    const sizeMark = marks.find((m) => m.type.name === 'font_size');
    if (sizeMark) {
      const hp = Number(sizeMark.attrs['halfPoints'] ?? 22);
      props.push(emptyEl('w:sz', { 'w:val': hp }));
      props.push(emptyEl('w:szCs', { 'w:val': hp }));
    } else if (marks.some((m) => m.type.name === 'pilcrow_marker')) {
      // pilcrow_marker carries no attrs — Verbatim's canonical 6-pt
      // pilcrow encoding is `<w:sz w:val="12"/>`. Emit when no explicit
      // font_size is present (font_size takes precedence if both are
      // somehow set on the same run, though that shouldn't happen in
      // practice).
      props.push(emptyEl('w:sz', { 'w:val': 12 }));
      props.push(emptyEl('w:szCs', { 'w:val': 12 }));
    }

    if (
      marks.some((m) => m.type.name === 'underline_mark' || m.type.name === 'underline_direct')
    ) {
      // underline_mark: dual-encoding per NOTES-verbatim.md §5 gotcha
      //   #1 — rStyle="StyleUnderline" (already emitted above) AND
      //   <w:u w:val="single"/>.
      // underline_direct: just <w:u w:val="single"/>, no rStyle.
      props.push(emptyEl('w:u', { 'w:val': 'single' }));
    }

    const highlightMark = marks.find((m) => m.type.name === 'highlight');
    if (highlightMark) {
      const c = String(highlightMark.attrs['color'] ?? 'yellow');
      props.push(emptyEl('w:highlight', { 'w:val': c }));
    }

    const shadingMark = marks.find((m) => m.type.name === 'shading');
    if (shadingMark) {
      const c = String(shadingMark.attrs['color'] ?? 'D2D2D2');
      props.push(emptyEl('w:shd', { 'w:val': 'clear', 'w:color': 'auto', 'w:fill': c }));
    }

    if (props.length === 0) return '';
    return el('w:rPr', {}, props.join(''));
  }

  private registerHyperlink(href: string): string {
    const existing = this.rels.find((r) => r.target === href);
    if (existing) return existing.rId;
    const rId = `rId${this.nextRelId++}`;
    this.rels.push({ rId, target: href });
    return rId;
  }

  private buildRelsXml(): string {
    const inner: string[] = [];
    inner.push(
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    );
    for (const rel of this.rels) {
      inner.push(
        `<Relationship Id="${rel.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${rel.target}" TargetMode="External"/>`,
      );
    }
    for (const rel of this.imageRels) {
      inner.push(
        `<Relationship Id="${rel.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${rel.target}"/>`,
      );
    }
    return `${RELS_OPEN}${inner.join('')}${RELS_CLOSE}`;
  }
}

/**
 * Build the OOXML drawing XML for an inline picture. Self-contains the
 * required namespaces (wp, a, pic) so we don't have to hoist them onto
 * <w:document>. Standard inline-picture shape — no effects, no
 * positioning, no theme styling.
 */
function buildDrawingXml(opts: {
  rId: string;
  cx: number;
  cy: number;
  docPrId: number;
  alt: string;
}): string {
  const { rId, cx, cy, docPrId, alt } = opts;
  const altEsc = escText(alt);
  const name = `Picture ${docPrId}`;
  return (
    '<w:drawing>' +
      `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${cx}" cy="${cy}"/>` +
        '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
        `<wp:docPr id="${docPrId}" name="${escText(name)}" descr="${altEsc}"/>` +
        '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
          '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
            '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
              '<pic:nvPicPr>' +
                `<pic:cNvPr id="${docPrId}" name="${escText(name)}" descr="${altEsc}"/>` +
                '<pic:cNvPicPr/>' +
              '</pic:nvPicPr>' +
              '<pic:blipFill>' +
                `<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rId}"/>` +
                '<a:stretch><a:fillRect/></a:stretch>' +
              '</pic:blipFill>' +
              '<pic:spPr>' +
                '<a:xfrm>' +
                  '<a:off x="0" y="0"/>' +
                  `<a:ext cx="${cx}" cy="${cy}"/>` +
                '</a:xfrm>' +
                '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
              '</pic:spPr>' +
            '</pic:pic>' +
          '</a:graphicData>' +
        '</a:graphic>' +
      '</wp:inline>' +
    '</w:drawing>'
  );
}

/** Public API: schema doc → document.xml + rels. */
export function exportDoc(doc: PMNode): ExportResult {
  return new DocxExporter().exportDoc(doc);
}
