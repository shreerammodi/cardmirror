/**
 * OOXML parsing helpers.
 *
 * Uses fast-xml-parser with preserveOrder so we maintain document order
 * (essential for paragraph and run sequences).
 */

import { XMLParser } from 'fast-xml-parser';

/**
 * Order-preserving parse output. fast-xml-parser with preserveOrder:true
 * returns arrays of single-keyed objects, with attributes under ':@'.
 *
 * Example: <w:p><w:r><w:t>hi</w:t></w:r></w:p> →
 *   [{ 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': 'hi' }] }] }] }]
 */
export type XmlNode = { [tag: string]: XmlNode[] | string } & {
  ':@'?: Record<string, string>;
  '#text'?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  preserveOrder: true,
  trimValues: false,
  parseAttributeValue: false,
  parseTagValue: false,
});

export function parseXml(xml: string): XmlNode[] {
  return parser.parse(xml) as XmlNode[];
}

/**
 * From a list of order-preserved nodes, find the first child with the
 * given tag name. Returns null if not found.
 */
export function findChild(nodes: XmlNode[], tag: string): XmlNode | null {
  for (const node of nodes) {
    if (tag in node) return node;
  }
  return null;
}

/**
 * From a list of order-preserved nodes, return all children with the
 * given tag name (in order).
 */
export function findChildren(nodes: XmlNode[], tag: string): XmlNode[] {
  return nodes.filter((n) => tag in n);
}

/** Extract attributes from a node. */
export function attrs(node: XmlNode): Record<string, string> {
  return node[':@'] ?? {};
}

/** Get the children array of a tagged node. */
export function children(node: XmlNode, tag: string): XmlNode[] {
  const value = node[tag];
  if (Array.isArray(value)) return value;
  return [];
}

/** Re-serialize a parsed XmlNode list back to an XML fragment.
 *  Inverse of `parseXml` for the subset of OOXML we produce — preserves
 *  element order, attributes, and `#text` leaves. Used when we want to
 *  round-trip opaque sub-trees (e.g. `<w:tblPr>` extras) verbatim
 *  without modeling every child element in the schema. */
export function serializeXmlNodes(nodes: XmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    out += serializeXmlNode(node);
  }
  return out;
}

function serializeXmlNode(node: XmlNode): string {
  for (const key of Object.keys(node)) {
    if (key === ':@') continue;
    if (key === '#text') {
      return escText(String(node[key] ?? ''));
    }
    // Tag node — single tag key per node in preserveOrder mode.
    const attrPart = serializeAttrs(node[':@'] ?? {});
    const value = node[key];
    if (Array.isArray(value) && value.length > 0) {
      return `<${key}${attrPart}>${serializeXmlNodes(value)}</${key}>`;
    }
    return `<${key}${attrPart}/>`;
  }
  return '';
}

function serializeAttrs(a: Record<string, string>): string {
  let out = '';
  for (const [k, v] of Object.entries(a)) {
    out += ` ${k}="${escAttr(String(v))}"`;
  }
  return out;
}

/** Minimal XML escape helpers inlined here so parse.ts has no
 *  upward dependency on `ooxml/xml.ts`. */
function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * Get the text content of a node by recursively concatenating all
 * #text children.
 */
export function textContent(node: XmlNode | XmlNode[]): string {
  const nodes = Array.isArray(node) ? node : [node];
  let out = '';
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n)) {
      if (k === ':@') continue;
      if (k === '#text') {
        out += String(v ?? '');
      } else if (Array.isArray(v)) {
        out += textContent(v);
      }
    }
  }
  return out;
}
