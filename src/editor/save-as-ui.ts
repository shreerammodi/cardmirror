/**
 * Save As modal. Promise-based — resolves with the user's chosen
 * filename + format + export options, or `null` if they cancelled.
 *
 * Two output formats:
 *   - `cmir` — CardMirror native (lossless JSON, no Verbatim round-
 *     trip). Recommended for docs that live entirely in CardMirror.
 *   - `docx` — Microsoft Word / Verbatim. Use for sharing with
 *     teammates still on Verbatim, or for any tournament-day round
 *     where the receiving party needs Word.
 *
 * Layout: a Name section, a Format section, then a Save section
 * with one-click presets — As-Is (everything), Send Doc (no
 * analytics / undertags / comments), Read Doc (read-mode export),
 * each with its description as a caption below the button — followed
 * by a Custom Save block (comments / analytics / undertags
 * checkboxes + a Save Custom button), then Cancel. The format radio
 * drives the default filename extension and which filter the OS
 * dialog defaults to; all content options apply equally to both
 * formats.
 */

export type SaveAsFormat = 'cmir' | 'docx';

export interface SaveAsResult {
  filename: string;
  /** Which on-disk format the user picked. */
  format: SaveAsFormat;
  /** Include comments in the saved doc. */
  includeComments: boolean;
  /** Include analytic content. When false, doc-level analytic_units
   *  drop entirely; in-card analytic paragraphs drop. */
  includeAnalytics: boolean;
  /** Include undertag paragraphs (doc-level and inside cards /
   *  analytic_units). */
  includeUndertags: boolean;
  /** Save only what's visible in read mode: headings, tags, in-card
   *  analytics, cite-marked text inside cite_paragraphs, highlighted
   *  text inside body paragraphs. Mutually exclusive with the three
   *  include-* options above. */
  readMode: boolean;
}

export interface OpenSaveAsOptions {
  /** Initial filename suggestion (with or without an extension — the
   *  dialog will normalize on confirm). */
  initialFilename: string;
  /** Default format to pre-select. Usually the current doc's format
   *  (so re-saving stays in the same format unless the user changes
   *  it). New docs default to `'cmir'` — the recommended forward-
   *  looking native format. */
  defaultFormat: SaveAsFormat;
}

export function openSaveAs(opts: OpenSaveAsOptions): Promise<SaveAsResult | null> {
  return new Promise((resolve) => {
    new SaveAsModal(opts, resolve);
  });
}

const FORMAT_LABELS: Record<SaveAsFormat, string> = {
  cmir: 'CardMirror native (.cmir)',
  docx: 'Microsoft Word (.docx)',
};

const FORMAT_BLURBS: Record<SaveAsFormat, string> = {
  cmir: 'Lossless. No conversion. Best for docs that stay in CardMirror.',
  docx: 'For sharing with Verbatim users or any Word-based workflow.',
};

class SaveAsModal {
  private readonly overlay: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private filenameInput!: HTMLInputElement;
  private commentsBox!: HTMLInputElement;
  private analyticsBox!: HTMLInputElement;
  private undertagsBox!: HTMLInputElement;
  /** Radio inputs keyed by format id. */
  private formatRadios!: Record<SaveAsFormat, HTMLInputElement>;
  private settled = false;
  private currentFormat: SaveAsFormat;

  constructor(
    private readonly opts: OpenSaveAsOptions,
    private readonly settle: (r: SaveAsResult | null) => void,
  ) {
    this.currentFormat = opts.defaultFormat;
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-save-as-overlay';

    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-save-as-dialog';
    this.overlay.appendChild(this.dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.cancel();
    });

    document.addEventListener('keydown', this.handleKey);

    this.render();
    document.body.appendChild(this.overlay);

    requestAnimationFrame(() => {
      this.filenameInput.focus();
      // Select just the basename, not the extension, so the user can
      // type a new name without clobbering the extension.
      const dot = this.filenameInput.value.lastIndexOf('.');
      if (dot > 0) {
        this.filenameInput.setSelectionRange(0, dot);
      } else {
        this.filenameInput.select();
      }
    });
  }

  private readonly handleKey = (e: KeyboardEvent): void => {
    if (this.settled) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
    }
  };

  private render(): void {
    const header = document.createElement('header');
    header.className = 'pmd-save-as-header';
    const title = document.createElement('h2');
    title.textContent = 'Save As';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-save-as-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Cancel';
    closeBtn.addEventListener('click', () => this.cancel());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    const form = document.createElement('form');
    form.className = 'pmd-save-as-body';
    // Enter / the Save Custom submit button save with the current
    // Include checkbox state.
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.confirmWith({
        includeComments: this.commentsBox.checked,
        includeAnalytics: this.analyticsBox.checked,
        includeUndertags: this.undertagsBox.checked,
        readMode: false,
      });
    });

    // FILE NAME and FORMAT — the what/where, each under its heading.
    form.appendChild(this.buildFileNameSection());
    form.appendChild(this.buildFormatSection());

    // SAVE section heading — covers the presets and the custom-save
    // block below.
    const saveHeading = document.createElement('div');
    saveHeading.className = 'pmd-save-as-options-heading';
    saveHeading.textContent = 'Save';
    form.appendChild(saveHeading);

    // One-click presets — common content configurations. Each saves
    // immediately with the filename + format above; the description
    // shows as a caption below the button.
    const presets = document.createElement('div');
    presets.className = 'pmd-save-as-presets';
    presets.appendChild(
      this.buildPreset(
        'As-Is',
        'Includes everything in the document.',
        { includeComments: true, includeAnalytics: true, includeUndertags: true, readMode: false },
      ),
    );
    presets.appendChild(
      this.buildPreset(
        'Send Doc',
        'Excludes analytics, undertags, and comments.',
        { includeComments: false, includeAnalytics: false, includeUndertags: false, readMode: false },
      ),
    );
    presets.appendChild(
      this.buildPreset(
        'Read Doc',
        'Exports the read-mode view of the document.',
        { includeComments: false, includeAnalytics: false, includeUndertags: false, readMode: true },
      ),
    );
    form.appendChild(presets);

    // Custom Save: the Include checkboxes + a Save Custom button.
    const options = document.createElement('div');
    options.className = 'pmd-save-as-options';
    options.appendChild(this.buildOptionsHeading());

    this.commentsBox = this.buildCheckbox('Include comments', true);
    this.analyticsBox = this.buildCheckbox('Include analytics', true);
    this.undertagsBox = this.buildCheckbox('Include undertags', true);
    options.appendChild(this.commentsBox.parentElement!);
    options.appendChild(this.analyticsBox.parentElement!);
    options.appendChild(this.undertagsBox.parentElement!);

    const customSave = document.createElement('button');
    customSave.type = 'submit';
    customSave.className = 'pmd-save-as-btn pmd-save-as-btn-primary pmd-save-as-custom-save';
    customSave.textContent = 'Save Custom';
    options.appendChild(customSave);

    form.appendChild(options);

    // Cancel sits alone at the very bottom.
    const footer = document.createElement('footer');
    footer.className = 'pmd-save-as-footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-save-as-btn pmd-save-as-btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.cancel());
    footer.appendChild(cancel);
    form.appendChild(footer);

    this.dialog.appendChild(form);
  }

  /** Build a preset cell: a primary (blue) button with its
   *  description as a caption below. Clicking the button saves
   *  immediately with the given content options (filename + format
   *  read live from the inputs). */
  private buildPreset(
    title: string,
    sub: string,
    opts: {
      includeComments: boolean;
      includeAnalytics: boolean;
      includeUndertags: boolean;
      readMode: boolean;
    },
  ): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'pmd-save-as-preset';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-save-as-btn pmd-save-as-btn-primary pmd-save-as-preset-btn';
    btn.textContent = title;
    btn.addEventListener('click', () => this.confirmWith(opts));
    cell.appendChild(btn);
    const caption = document.createElement('span');
    caption.className = 'pmd-save-as-preset-sub';
    caption.textContent = sub;
    cell.appendChild(caption);
    return cell;
  }

  /** FILE NAME section: a heading + the file-name input. */
  private buildFileNameSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pmd-save-as-field';
    const heading = document.createElement('div');
    heading.className = 'pmd-save-as-options-heading';
    heading.textContent = 'Name';
    wrap.appendChild(heading);
    this.filenameInput = document.createElement('input');
    this.filenameInput.type = 'text';
    this.filenameInput.className = 'pmd-save-as-input';
    this.filenameInput.value = withExtension(this.opts.initialFilename, this.currentFormat);
    this.filenameInput.spellcheck = false;
    this.filenameInput.autocomplete = 'off';
    wrap.appendChild(this.filenameInput);
    return wrap;
  }

  /** FORMAT section: a heading + the cmir / docx radio rows. */
  private buildFormatSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pmd-save-as-format';
    const heading = document.createElement('div');
    heading.className = 'pmd-save-as-options-heading';
    heading.textContent = 'Format';
    wrap.appendChild(heading);

    const groupName = `pmd-save-as-format-${Math.random().toString(36).slice(2, 8)}`;
    this.formatRadios = { cmir: null!, docx: null! };
    for (const id of ['cmir', 'docx'] as const) {
      const row = document.createElement('label');
      row.className = 'pmd-save-as-format-row';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = groupName;
      input.value = id;
      input.checked = id === this.currentFormat;
      input.addEventListener('change', () => {
        if (input.checked) this.setFormat(id);
      });
      this.formatRadios[id] = input;
      row.appendChild(input);
      const text = document.createElement('span');
      text.className = 'pmd-save-as-format-row-text';
      const label = document.createElement('span');
      label.className = 'pmd-save-as-format-row-label';
      label.textContent = FORMAT_LABELS[id];
      text.appendChild(label);
      const blurb = document.createElement('span');
      blurb.className = 'pmd-save-as-format-row-blurb';
      blurb.textContent = FORMAT_BLURBS[id];
      text.appendChild(blurb);
      row.appendChild(text);
      wrap.appendChild(row);
    }
    return wrap;
  }

  /** Update the format and swap the filename's extension to match. */
  private setFormat(format: SaveAsFormat): void {
    this.currentFormat = format;
    this.filenameInput.value = withExtension(this.filenameInput.value, format);
  }

  private buildOptionsHeading(): HTMLElement {
    const h = document.createElement('div');
    h.className = 'pmd-save-as-options-heading';
    h.textContent = 'Custom Save';
    return h;
  }

  private buildCheckbox(labelText: string, defaultChecked: boolean): HTMLInputElement {
    const label = document.createElement('label');
    label.className = 'pmd-save-as-option';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = defaultChecked;
    label.appendChild(box);
    const text = document.createElement('span');
    text.textContent = labelText;
    label.appendChild(text);
    return box;
  }

  /** Save with the given content options + the live filename /
   *  format. Shared by every preset and the Save Custom submit.
   *  No-op on an empty filename. */
  private confirmWith(opts: {
    includeComments: boolean;
    includeAnalytics: boolean;
    includeUndertags: boolean;
    readMode: boolean;
  }): void {
    const trimmed = this.filenameInput.value.trim();
    if (!trimmed) return;
    this.finish({
      filename: withExtension(trimmed, this.currentFormat),
      format: this.currentFormat,
      ...opts,
    });
  }

  private cancel(): void {
    this.finish(null);
  }

  private finish(result: SaveAsResult | null): void {
    if (this.settled) return;
    this.settled = true;
    document.removeEventListener('keydown', this.handleKey);
    this.overlay.remove();
    this.settle(result);
  }
}

/** Normalize a filename to end with the right extension for the
 *  chosen format. Strips other known extensions first so swapping
 *  the format radio replaces `.docx` with `.cmir` and vice versa
 *  without piling them up. */
function withExtension(filename: string, format: SaveAsFormat): string {
  let base = filename.trim();
  for (const ext of ['.cmir', '.docx']) {
    if (base.toLowerCase().endsWith(ext)) {
      base = base.slice(0, -ext.length);
      break;
    }
  }
  return `${base}.${format}`;
}
