/**
 * .docx zip read/write helpers.
 *
 * A .docx is a zip with a specific file layout:
 *   [Content_Types].xml          — declares MIME types per part
 *   _rels/.rels                  — top-level relationships
 *   word/document.xml            — the actual document content
 *   word/styles.xml              — style definitions
 *   word/_rels/document.xml.rels — document part relationships
 *   word/settings.xml            — editor settings
 *   word/fontTable.xml           — fonts referenced
 *   word/webSettings.xml, etc.   — optional
 *
 * For our v0 we emit a minimal but valid set: document.xml + styles.xml +
 * the boilerplate Content_Types + rels files. Anything more elaborate
 * (themes, fonts, settings) we copy through if present in an input zip
 * but don't generate from scratch.
 */

import JSZip from 'jszip';
import { CANONICAL_STYLES_XML } from './styles.js';
import { XML_PROLOG } from './xml.js';

/** Loaded docx — an in-memory zip we can read parts from and modify. */
export class Docx {
  constructor(private zip: JSZip) {}

  /** Load a .docx from a Uint8Array (Node Buffer / browser ArrayBuffer-derived). */
  static async load(bytes: Uint8Array | ArrayBuffer): Promise<Docx> {
    const zip = await JSZip.loadAsync(bytes);
    return new Docx(zip);
  }

  /** Construct a fresh, minimal .docx with the canonical style block. */
  static empty(): Docx {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', TOP_LEVEL_RELS_XML);
    zip.file('word/styles.xml', CANONICAL_STYLES_XML);
    zip.file('word/_rels/document.xml.rels', DOCUMENT_RELS_XML);
    zip.file('word/document.xml', EMPTY_DOCUMENT_XML);
    return new Docx(zip);
  }

  /** Read a part as a string. */
  async readText(path: string): Promise<string | null> {
    const file = this.zip.file(path);
    if (!file) return null;
    return file.async('string');
  }

  /** Write or overwrite a part. */
  writeText(path: string, content: string): void {
    this.zip.file(path, content);
  }

  /** Read a part as raw bytes. */
  async readBinary(path: string): Promise<Uint8Array | null> {
    const file = this.zip.file(path);
    if (!file) return null;
    return file.async('uint8array');
  }

  /** Write or overwrite a binary part. */
  writeBinary(path: string, bytes: Uint8Array): void {
    this.zip.file(path, bytes);
  }

  /** Insert one or more `<Override>` entries into the
   *  `[Content_Types].xml` part. Used by `toDocx` to declare any
   *  optional parts beyond the baseline (comments.xml,
   *  commentsExtended.xml, etc.). */
  async addContentTypeOverrides(overrides: { partName: string; contentType: string }[]): Promise<void> {
    if (overrides.length === 0) return;
    const ct = await this.readText('[Content_Types].xml');
    if (!ct) return;
    const additions = overrides
      .map((o) => `<Override PartName="${o.partName}" ContentType="${o.contentType}"/>`)
      .join('');
    const updated = ct.replace('</Types>', `${additions}</Types>`);
    this.writeText('[Content_Types].xml', updated);
  }

  /** Get the raw zip for advanced operations. */
  raw(): JSZip {
    return this.zip;
  }

  /** Serialize to bytes (for writing to disk or sending across a wire). */
  async toBuffer(): Promise<Uint8Array> {
    return this.zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }

  /** List all part paths in the zip. */
  paths(): string[] {
    const paths: string[] = [];
    this.zip.forEach((path) => {
      paths.push(path);
    });
    return paths;
  }
}

// -------- Boilerplate XML for fresh docx --------

const CONTENT_TYPES_XML = `${XML_PROLOG}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="gif" ContentType="image/gif"/>
  <Default Extension="bmp" ContentType="image/bmp"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="webp" ContentType="image/webp"/>
  <Default Extension="tif" ContentType="image/tiff"/>
  <Default Extension="tiff" ContentType="image/tiff"/>
  <Default Extension="emf" ContentType="image/x-emf"/>
  <Default Extension="wmf" ContentType="image/x-wmf"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const TOP_LEVEL_RELS_XML = `${XML_PROLOG}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `${XML_PROLOG}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const EMPTY_DOCUMENT_XML = `${XML_PROLOG}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">
  <w:body>
    <w:p/>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
