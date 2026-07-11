/**
 * Voice controller: session lifecycle glue between the main-process
 * recognition service and the editor (SPEC-voice.md §12 items 2–4).
 * Owns mic capture, event routing into the dispatcher, the feedback
 * pill, and (debounced) vocabulary shipping. Desktop-only — the web
 * edition has no recognition host.
 */
import type { EditorView } from 'prosemirror-view';
import { alertDialog, confirmDialog } from '../text-prompt.js';
import type { RibbonContext } from '../ribbon-commands.js';
import { settings } from '../settings.js';
import { showToast } from '../toast.js';
import { VOICE_NEAR_RADIUS } from './align.js';
import { MicCapture } from './capture.js';
import { commandNameVocabulary } from './please-match.js';
import {
  applyVoiceCommand,
  applyDictation,
  handlePaintPartial,
  activeUiInput,
  typeIntoUiInput,
  type DispatchDeps,
} from './dispatch.js';
import { patchVoiceState, voicePluginKey } from './plugin.js';
import { VoicePill } from './ui.js';
import type { VoiceEndedEvent, VoiceEvent, VoiceLevel } from './types';

/** The preload voice surface (subset of window.electronAPI). */
interface VoiceHostApi {
  voiceStart(opts?: {
    autoSleepSeconds?: number;
    dictationModel?: 'standard' | 'large';
  }): Promise<{
    ok: boolean;
    error?: string;
    modelLoadMs?: number;
    largeDictationMissing?: boolean;
    largeDictationUnsupported?: boolean;
  }>;
  voiceStop(): Promise<void>;
  voicePushAudio(chunk: ArrayBuffer): void;
  voiceSetVocabulary(docText: string): Promise<void>;
  voiceClipboard(op: 'copy' | 'cut' | 'paste'): Promise<void>;
  voiceSendKey(key: string): Promise<void>;
  onVoiceEvent(handler: (event: unknown) => void): () => void;
  onVoiceLevel(handler: (level: VoiceLevel) => void): () => void;
  voiceBaseModelInfo?(): Promise<{ present: boolean; downloading: boolean }>;
  voiceDownloadBaseModel?(): Promise<{ ok: boolean; error?: string }>;
}

function voiceHost(): VoiceHostApi | null {
  const api = (window as unknown as { electronAPI?: Partial<VoiceHostApi> }).electronAPI;
  return api && typeof api.voiceStart === 'function' ? (api as VoiceHostApi) : null;
}

const VOCAB_POLL_MS = 2000;

export class VoiceController {
  private capture = new MicCapture();
  private pill: VoicePill | null = null;
  private unsubscribers: Array<() => void> = [];
  private vocabTimer: ReturnType<typeof setInterval> | null = null;
  private lastVocabText: string | null = null;
  private active = false;
  /** Re-entrancy guard: `toggle()` awaits several times before `active`
   *  flips, so a double Ctrl-Shift-V would otherwise race two starts —
   *  duplicate capture streams (hot mic leak), stacked vocab timers.
   *  The generation counter also cancels an in-flight start when
   *  `stop()` lands mid-way. */
  private starting = false;
  private generation = 0;
  /** Input value before live dictation partials started revising it. */
  private uiInputBaseline: string | null = null;

  constructor(
    private deps: {
      getView: () => EditorView | null;
      ribbonCtx: RibbonContext;
    },
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  async toggle(): Promise<void> {
    if (this.starting) return; // ignore double-press during startup
    if (this.active) {
      this.stop();
      return;
    }
    this.starting = true;
    try {
      await this.startSession();
    } finally {
      this.starting = false;
    }
  }

  private async startSession(): Promise<void> {
    const gen = ++this.generation;
    const cancelled = () => gen !== this.generation;
    const host = voiceHost();
    if (!host) {
      showToast('Voice control needs the desktop app', { durationMs: 1600 });
      return;
    }
    const view = this.deps.getView();
    if (!view) return;

    this.pill ??= new VoicePill(() => {
      if (this.active) this.stop();
    });
    this.pill.setListening(true);
    this.pill.setEcho('loading model…', true);

    const res = await host.voiceStart({
      autoSleepSeconds: settings.get('voiceAutoSleepSeconds'),
      dictationModel: settings.get('voiceDictationModel'),
    });
    if (cancelled()) {
      void host.voiceStop();
      this.pill?.setListening(false);
      return;
    }
    if (res.ok && res.largeDictationMissing) {
      showToast('Large dictation model not downloaded — using standard (see Settings)', {
        durationMs: 2600,
      });
    }
    if (res.ok && res.largeDictationUnsupported) {
      showToast('Large dictation model needs a Node runtime on this install — using standard', {
        durationMs: 2600,
      });
    }
    if (!res.ok) {
      this.pill.setListening(false);
      // The base model is a first-use download, not a bundled asset —
      // "missing" is the common, recoverable case: offer to fetch it
      // rather than showing a dead-end error.
      if (res.error === 'voice-model-missing') {
        void this.offerBaseModelDownload(host);
        return;
      }
      let msg: string;
      if (res.error === 'voice-assets-missing') {
        msg =
          'Voice recognizer library missing — reinstall CardMirror (developers: set CARDMIRROR_VOICE_DIR)';
      } else if (res.error === 'voice-mic-denied') {
        msg = 'Microphone access denied — enable it in System Settings → Privacy & Security → Microphone';
      } else {
        msg = `Voice failed to start: ${res.error}`;
      }
      showToast(msg, { durationMs: res.error === 'voice-mic-denied' ? 4000 : 2400 });
      return;
    }

    const ui: DispatchDeps['ui'] = {
      echo: (text, ok) => {
        this.pill?.setEcho(text, ok);
        if (ok) this.pill?.earconAccept();
        else this.pill?.earconReject();
      },
      hint: (text) => {
        this.pill?.setEcho(text, false);
      },
    };
    const dispatchDeps: DispatchDeps = {
      ribbonCtx: this.deps.ribbonCtx,
      ui,
      native: {
        copy: () => host.voiceClipboard('copy'),
        cut: () => host.voiceClipboard('cut'),
        paste: () => host.voiceClipboard('paste'),
        sendKey: (key) => host.voiceSendKey(key),
      },
      visibleRange: () => {
        const v = this.deps.getView();
        return v ? editorVisibleRange(v) : null;
      },
    };

    let announcedReady = false;
    this.unsubscribers.push(
      host.onVoiceEvent((raw) => this.handleEvent(raw as VoiceEvent | VoiceEndedEvent, dispatchDeps)),
      host.onVoiceLevel((level) => {
        this.pill?.setLevel(level);
        this.pill?.setAutoSleepCountdown(level.autoSleepRemainingMs ?? null);
        if (!announcedReady && !level.calibrating) {
          announcedReady = true;
          this.pill?.setEcho('listening', true);
          this.pill?.earconMode('command');
        }
      }),
    );

    const deviceId = settings.get('voiceInputDeviceId') || undefined;
    try {
      await this.capture.start((chunk) => host.voicePushAudio(chunk), deviceId);
      if (cancelled()) {
        this.capture.stop();
        void host.voiceStop();
        this.pill?.setListening(false);
        return;
      }
    } catch (err) {
      // A saved device that's gone (unplugged headset at a tournament)
      // must not brick voice — fall back to the system default.
      if (deviceId) {
        try {
          await this.capture.start((chunk) => host.voicePushAudio(chunk));
          showToast('Saved microphone not found — using system default', { durationMs: 2000 });
        } catch (err2) {
          this.stop();
          showToast(`Microphone unavailable: ${String(err2)}`, { durationMs: 2400 });
          return;
        }
      } else {
        this.stop();
        showToast(`Microphone unavailable: ${String(err)}`, { durationMs: 2400 });
        return;
      }
    }

    // Device changes mid-session swap the capture stream live; the
    // recognizer keeps running (it just sees a gap, then new audio).
    let activeDeviceId = deviceId ?? '';
    this.unsubscribers.push(
      settings.subscribe((snapshot) => {
        if (!this.active || snapshot.voiceInputDeviceId === activeDeviceId) return;
        activeDeviceId = snapshot.voiceInputDeviceId;
        this.capture.stop();
        void this.capture
          .start((chunk) => host.voicePushAudio(chunk), activeDeviceId || undefined)
          .catch((err) => showToast(`Microphone switch failed: ${String(err)}`, { durationMs: 2400 }));
      }),
    );

    this.active = true;
    this.pill.setMode('command');
    this.pill.setEcho('listening (calibrating…)', true);
    document.body.classList.add('pmd-voice-listening'); // nav ordinals on
    setBodyModeClass('command');
    patchVoiceState(view, { listening: true, mode: 'command' });

    // Vocabulary shipping (§12 item 4): VIEWPORT-derived, not whole-doc.
    // Grammar rebuild and decode cost scale with vocabulary size, and
    // both run synchronously in the main process — whole-doc text from
    // a real debate file janks the entire app.
    const ship = () => {
      const v = this.deps.getView();
      if (!v) return;
      const text = vocabularyText(v);
      if (text === this.lastVocabText) return;
      this.lastVocabText = text;
      void host.voiceSetVocabulary(text);
    };
    ship();
    this.vocabTimer = setInterval(ship, VOCAB_POLL_MS);
  }

  /** First-run flow when the base recognition model isn't downloaded
   *  yet. Confirm, kick off the background download, and DON'T
   *  auto-start when it lands — a multi-minute download outlasts the
   *  user's attention, and a surprise hot mic is worse than a second
   *  key press. Instead inform them, unmissably, that it's ready. Live
   *  progress is shown in Settings → the voice section. */
  private async offerBaseModelDownload(host: VoiceHostApi): Promise<void> {
    if (!host.voiceDownloadBaseModel || !host.voiceBaseModelInfo) {
      showToast(
        "Voice model not downloaded, and this install can't fetch it — update CardMirror (developers: set CARDMIRROR_VOICE_DIR)",
        { durationMs: 3200 },
      );
      return;
    }
    const info = await host.voiceBaseModelInfo();
    if (info.downloading) {
      showToast('Voice model is already downloading — you’ll be notified when it’s ready', {
        durationMs: 3200,
      });
      return;
    }
    const proceed =
      typeof document !== 'undefined' &&
      (await confirmDialog(
        'Voice control needs a one-time download of its recognition model (about 130 MB). ' +
          'This can take a few minutes; you can keep working and you’ll be notified when it’s ready. ' +
          'Download now?',
        { okLabel: 'Download' },
      ));
    if (!proceed) return;
    showToast('Downloading voice model in the background…', { durationMs: 3200 });
    const res = await host.voiceDownloadBaseModel();
    if (res.ok) {
      // Modal, not a toast: after minutes away the user has moved on,
      // and the whole point is to catch their attention so the "ready"
      // state isn't a surprise the next time they hit the voice key.
      if (typeof document !== 'undefined') {
        await alertDialog('Voice model downloaded. Press the voice key (or the ribbon button) to start voice control.');
      }
    } else {
      const reason = res.error === 'download-in-progress' ? 'already in progress' : (res.error ?? 'unknown error');
      showToast(`Voice model download failed: ${reason}`, { durationMs: 4000 });
    }
  }

  stop(): void {
    this.generation++; // cancels any in-flight start
    this.active = false;
    this.capture.stop();
    for (const u of this.unsubscribers.splice(0)) u();
    if (this.vocabTimer) clearInterval(this.vocabTimer);
    this.vocabTimer = null;
    this.lastVocabText = null;
    void voiceHost()?.voiceStop();
    this.pill?.setListening(false);
    document.body.classList.remove('pmd-voice-listening');
    setBodyModeClass(null);
    const view = this.deps.getView();
    if (view) patchVoiceState(view, { listening: false, pendingDisambiguation: null, ghostText: null });
  }

  private handleEvent(event: VoiceEvent | VoiceEndedEvent, deps: DispatchDeps): void {
    // Out-of-band session termination (worker crash): stop everything
    // and SAY so — a dead session must never look like a listening one.
    if (event.kind === 'ended') {
      this.stop();
      showToast(`Voice stopped: ${event.reason}`, { durationMs: 2600 });
      return;
    }
    const view = this.deps.getView();
    if (!view) return;
    void this.routeEvent(view, event, deps)
      .catch((err) => {
        // A throw must not leave the loop looking dead — echo + earcon
        // and keep the session alive.
        console.error('voice: command failed', err);
        this.pill?.setEcho(`(error) ${event.raw ?? ''}`, false);
        this.pill?.earconReject();
      })
      .finally(() => {
        // Pen badge tracks sticky pen state after every event (§3.1).
        const v = this.deps.getView();
        const st = v ? voicePluginKey.getState(v.state) : null;
        if (st) this.pill?.setPen(st.pen.name, st.pen.color);
      });
  }

  private async routeEvent(view: EditorView, event: VoiceEvent, deps: DispatchDeps): Promise<void> {
    switch (event.kind) {
      case 'command':
        await applyVoiceCommand(view, event, deps);
        break;
      case 'dictation': {
        // Focused UI inputs (palette search fields, dialogs) receive
        // dictation instead of the document.
        const input = activeUiInput();
        if (input) {
          this.uiInputBaseline ??= input.value;
          input.value = this.uiInputBaseline;
          typeIntoUiInput(input, event.text);
          this.uiInputBaseline = null;
        } else {
          applyDictation(view, event);
        }
        this.pill?.setEcho(event.text, true);
        break;
      }
      case 'dictation-partial': {
        const input = activeUiInput();
        if (input) {
          // Live search-as-you-speak: the field updates with the
          // in-progress transcript so palettes filter in real time; an
          // empty partial (utterance closing) restores the baseline —
          // the final segment, if any, then commits on top of it.
          if (!event.text) {
            if (this.uiInputBaseline !== null) {
              input.value = this.uiInputBaseline;
              input.dispatchEvent(new InputEvent('input', { bubbles: true }));
              this.uiInputBaseline = null;
            }
          } else {
            this.uiInputBaseline ??= input.value;
            input.value = this.uiInputBaseline;
            typeIntoUiInput(input, event.text);
          }
          break;
        }
        // Provisional ghost text at the cursor; cleared by an empty
        // partial when the utterance closes.
        patchVoiceState(view, { ghostText: event.text || null });
        break;
      }
      case 'paint-partial':
        handlePaintPartial(view, event.text);
        break;
      case 'rejection':
        this.pill?.setEcho(`(${event.reason}) "${event.raw}"`, false);
        // Out-of-grammar = stray speech; with an open mic it's routine,
        // so it stays visual-only. Low-conf / invalid-utterance mean
        // "heard you, refused" — those beep.
        if (event.reason !== 'out-of-grammar') this.pill?.earconReject();
        patchVoiceState(view, {
          appendLog: { utteranceId: event.utteranceId, kind: 'rejection', text: event.raw },
        });
        break;
      case 'mode': {
        this.pill?.setMode(event.to);
        this.pill?.earconMode(event.to);
        setBodyModeClass(event.to);
        // Paint session lives exactly as long as paint mode: anchored
        // at the cursor on entry, dropped on exit (commits happen per
        // utterance while inside).
        const paintSession =
          event.to === 'paint'
            ? {
                anchor: view.state.selection.head,
                provisional: [],
                headPos: view.state.selection.head,
              }
            : null;
        patchVoiceState(view, {
          mode: event.to,
          paintSession,
          appendLog: { utteranceId: event.utteranceId, kind: 'mode', text: event.trigger },
        });
        break;
      }
    }
  }

  /** Current plugin-state snapshot (for menus/UI). */
  stateFor(view: EditorView) {
    return voicePluginKey.getState(view.state);
  }
}

/** Editor border tint per mode (§9 — reuses the body-class approach the
 *  drag surface uses for accept states). */
const MODE_CLASSES = ['pmd-voice-m-command', 'pmd-voice-m-dictation', 'pmd-voice-m-paint', 'pmd-voice-m-asleep'];
function setBodyModeClass(mode: string | null): void {
  document.body.classList.remove(...MODE_CLASSES);
  if (mode) document.body.classList.add(`pmd-voice-m-${mode}`);
}

/** Quote-decoding vocabulary source: text NEAR THE CURSOR (the spec's
 *  "phrase just ahead of me" case — and a tighter region is a stronger
 *  decode constraint), plus every card tag in the document so
 *  `card <quote>` long-range jumps stay decodable. Block-separated so
 *  words never concatenate across blocks, and so n-gram phrases don't
 *  cross block boundaries. */
function vocabularyText(view: EditorView): string {
  const { doc, selection } = view.state;
  const docSize = doc.content.size;
  const center = selection.head;
  const near = doc.textBetween(
    Math.max(0, center - VOICE_NEAR_RADIUS),
    Math.min(docSize, center + VOICE_NEAR_RADIUS),
    '\n',
    ' ',
  );
  const tags: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'tag') {
      tags.push(node.textContent);
      return false;
    }
    return true;
  });
  // Registry names ride along so `please <command name>` can decode.
  return `${near}\n${tags.join('\n')}\n${commandNameVocabulary()}`;
}

/** Doc range currently on screen, via viewport hit-testing (same
 *  technique as viewport-spellcheck) — feeds the quote picker's
 *  "identical matches onscreen" rule. */
function editorVisibleRange(view: EditorView): { from: number; to: number } {
  const rect = (view.dom as HTMLElement).getBoundingClientRect();
  const left = rect.left + Math.min(40, Math.max(2, rect.width / 2));
  const size = view.state.doc.content.size;
  const topHit = view.posAtCoords({ left, top: 2 });
  const botHit = view.posAtCoords({ left, top: window.innerHeight - 2 });
  let from = topHit ? topHit.pos : 0;
  let to = botHit ? botHit.pos : size;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
