/**
 * Modal text-prompt dialog. Drop-in replacement for the browser's
 * native `window.prompt` — Electron's BrowserWindows disable
 * `prompt()` outright (it throws "prompt() is not supported"), so
 * every prompt-style flow that needs to run on the desktop edition
 * routes through this helper instead.
 *
 * Returns the trimmed input on submit, or `null` on cancel (Esc,
 * Cancel button, or click outside the dialog box). Auto-focuses the
 * input on open; Enter submits, Esc cancels. Visual shape mirrors
 * the existing `pmd-route-dialog` overlays so it reads as part of
 * the same modal vocabulary.
 */

export interface TextPromptOptions {
  /** Title / question shown above the input. */
  message: string;
  /** Initial value of the input. Defaults to ''. */
  initial?: string;
  /** Placeholder when the input is empty. */
  placeholder?: string;
  /** Label on the submit button. Defaults to 'OK'. */
  okLabel?: string;
  /** Label on the cancel button. Defaults to 'Cancel'. */
  cancelLabel?: string;
}

export function promptForText(opts: TextPromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-text-prompt-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = opts.message;
    dialog.appendChild(header);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pmd-text-prompt-input';
    input.value = opts.initial ?? '';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    dialog.appendChild(input);

    const buttons = document.createElement('div');
    buttons.className = 'pmd-text-prompt-buttons';

    const cleanup = (): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'pmd-route-cancel';
    cancelBtn.textContent = opts.cancelLabel ?? 'Cancel';
    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
    buttons.appendChild(cancelBtn);

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'pmd-text-prompt-ok';
    okBtn.textContent = opts.okLabel ?? 'OK';
    okBtn.addEventListener('click', () => {
      cleanup();
      resolve(input.value.trim());
    });
    buttons.appendChild(okBtn);

    dialog.appendChild(buttons);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(null);
      }
    });

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        resolve(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        cleanup();
        resolve(input.value.trim());
      }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    // Focus + select so users can immediately type a replacement
    // when an initial value is supplied.
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}
