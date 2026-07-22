// @vitest-environment node
/**
 * The document write pipeline (doc-writes.ts) — regression coverage for
 * the field failure modes behind the 2026-07 save reports:
 *
 *  - a file renamed/deleted in Finder while open must FAIL the next
 *    in-place save with ENOENT (the old bare writeFile silently
 *    recreated the file at the stale path, forking the document);
 *  - a file rewritten by another program/device (Dropbox syncing down
 *    another machine's edit) must be refused with an EMODIFIED-marked
 *    error unless the caller passes force (the user's explicit
 *    "Overwrite" choice);
 *  - writes stage into a hidden tmp sibling then rename (no torn docs,
 *    no leftovers), and writes to one path are serialized.
 *
 * Real-fs tests in a per-run temp dir — the module IS the disk layer,
 * so mocking fs would test nothing.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveExistingDoc,
  saveNewDoc,
  DocExistsError,
  chainDocWrite,
  recordDiskStateFromDisk,
  resetDocWritesForTests,
  nearestExistingDir,
  CHANGED_ON_DISK_MARKER,
  FILE_LOCKED_MARKER,
} from '../../apps/desktop/src/doc-writes.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cardmirror-doc-writes-'));
let caseDir: string;
let n = 0;

beforeEach(async () => {
  resetDocWritesForTests();
  caseDir = path.join(tmpRoot, `case-${n++}`);
  await fs.mkdir(caseDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const docPath = (name = 'doc.cmir'): string => path.join(caseDir, name);
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8');
const exists = async (p: string): Promise<boolean> =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

/** Open-then-save baseline: the file exists and we've recorded what it
 *  looks like, exactly as a real document open does via readDocumentBytes. */
async function openedDoc(content = 'original', name?: string): Promise<string> {
  const p = docPath(name);
  await fs.writeFile(p, content);
  await recordDiskStateFromDisk(p);
  return p;
}

describe('saveExistingDoc — existence check (renamed/deleted file)', () => {
  it('saves in place when the file is present and unchanged', async () => {
    const p = await openedDoc();
    await saveExistingDoc(p, Buffer.from('v2'));
    expect(await read(p)).toBe('v2');
  });

  it('rejects with ENOENT when the file was deleted — and does NOT recreate it', async () => {
    const p = await openedDoc();
    await fs.unlink(p);
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(/ENOENT/);
    // The old bare writeFile resurrected the file here; the fork bug.
    expect(await exists(p)).toBe(false);
  });

  it('rejects with ENOENT at the OLD path after a rename — the renamed file is untouched', async () => {
    const p = await openedDoc();
    const renamed = docPath('renamed.cmir');
    await fs.rename(p, renamed);
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(/ENOENT/);
    expect(await exists(p)).toBe(false); // no silent fork at the stale path
    expect(await read(renamed)).toBe('original');
  });
});

describe('saveExistingDoc — changed-on-disk guard', () => {
  it('refuses to overwrite a file another program rewrote (size change)', async () => {
    const p = await openedDoc('original');
    await fs.writeFile(p, 'rewritten by another machine'); // different size
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(
      new RegExp(CHANGED_ON_DISK_MARKER),
    );
    expect(await read(p)).toBe('rewritten by another machine'); // their version survives
  });

  it('refuses on an mtime-only change (same size)', async () => {
    const p = await openedDoc('original');
    await fs.writeFile(p, 'ORIGINAL'); // same byte length
    // Force a distinct mtime regardless of filesystem timestamp granularity.
    const st = await fs.stat(p);
    await fs.utimes(p, st.atime, new Date(st.mtimeMs + 5000));
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(
      new RegExp(CHANGED_ON_DISK_MARKER),
    );
  });

  it('force (the explicit Overwrite choice) writes and re-baselines', async () => {
    const p = await openedDoc('original');
    await fs.writeFile(p, 'rewritten elsewhere');
    await saveExistingDoc(p, Buffer.from('v2'), { force: true });
    expect(await read(p)).toBe('v2');
    // The force write re-recorded the baseline: a normal save now passes.
    await saveExistingDoc(p, Buffer.from('v3'));
    expect(await read(p)).toBe('v3');
  });

  it('skips the guard for paths with no recorded baseline (journal recovery after restart)', async () => {
    const p = docPath();
    await fs.writeFile(p, 'pre-crash contents');
    // No recordDiskStateFromDisk — a fresh process saving a recovered doc.
    await saveExistingDoc(p, Buffer.from('recovered'));
    expect(await read(p)).toBe('recovered');
  });

  it("our own writes don't trip the guard (each save re-baselines)", async () => {
    const p = await openedDoc();
    await saveExistingDoc(p, Buffer.from('v2'));
    await saveExistingDoc(p, Buffer.from('v3 — longer'));
    await saveExistingDoc(p, Buffer.from('v4'));
    expect(await read(p)).toBe('v4');
  });

  it('saveNewDoc (Save As) baselines the path for later in-place saves', async () => {
    const p = docPath('new.cmir');
    await saveNewDoc(p, Buffer.from('first version'));
    expect(await read(p)).toBe('first version');
    // External rewrite after the Save As is caught by the next save…
    await fs.writeFile(p, 'external edit after save-as!');
    await expect(saveExistingDoc(p, Buffer.from('v2'))).rejects.toThrow(
      new RegExp(CHANGED_ON_DISK_MARKER),
    );
  });
});

describe('atomic writes', () => {
  it('leaves no tmp sibling behind and preserves content byte-for-byte', async () => {
    const p = await openedDoc();
    const payload = 'x'.repeat(64 * 1024);
    await saveExistingDoc(p, Buffer.from(payload));
    expect(await read(p)).toBe(payload);
    const leftovers = (await fs.readdir(caseDir)).filter((f) => f.includes('.cmtmp'));
    expect(leftovers).toEqual([]);
  });

  it('saveNewDoc creates missing parent folders when asked (bulk convert / send doc)', async () => {
    const p = path.join(caseDir, 'sub', 'deeper', 'out.cmir');
    await saveNewDoc(p, Buffer.from('exported'), { mkdir: true });
    expect(await read(p)).toBe('exported');
  });

  it('saveNewDoc failIfExists rejects with DocExistsError and leaves the occupant untouched', async () => {
    const p = docPath('speech.docx');
    await fs.writeFile(p, 'the earlier speech doc');
    await expect(
      saveNewDoc(p, Buffer.from('clobber?'), { failIfExists: true }),
    ).rejects.toBeInstanceOf(DocExistsError);
    expect(await read(p)).toBe('the earlier speech doc');
    // And without the flag the path still writes normally.
    const free = docPath('speech-2.docx');
    await saveNewDoc(free, Buffer.from('fresh'), { failIfExists: true });
    expect(await read(free)).toBe('fresh');
  });

  it('two concurrent failIfExists creates at one path: exactly one wins', async () => {
    // The reason the check lives INSIDE the write chain: fired
    // together, the loser must see the winner's file. With the old
    // access-then-write in the IPC handler, both could pass the
    // check and the second would silently clobber the first.
    const p = docPath('speech.docx');
    const results = await Promise.allSettled([
      saveNewDoc(p, Buffer.from('first'), { failIfExists: true }),
      saveNewDoc(p, Buffer.from('second'), { failIfExists: true }),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(['first', 'second']).toContain(await read(p));
  });

  it('preserves the existing file mode across the tmp+rename', async () => {
    if (process.platform === 'win32') return; // POSIX modes only
    const p = await openedDoc();
    await fs.chmod(p, 0o600);
    await saveExistingDoc(p, Buffer.from('v2'));
    expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
  });
});

describe('nearestExistingDir — where the Save-As dialog should open', () => {
  it("an intact file path resolves to the file's own folder", async () => {
    const p = await openedDoc();
    expect(await nearestExistingDir(p)).toBe(caseDir);
  });

  it('a deleted file still resolves to its (surviving) folder', async () => {
    const p = await openedDoc();
    await fs.unlink(p);
    expect(await nearestExistingDir(p)).toBe(caseDir);
  });

  it('a renamed folder resolves to the nearest surviving ancestor (the Word behavior)', async () => {
    // caseDir/tubs/aff/Aff.cmir, then "tubs" gets renamed — the deepest
    // survivor on the old path's chain is caseDir itself.
    const old = path.join(caseDir, 'tubs', 'aff', 'Aff.cmir');
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.writeFile(old, 'doc');
    await fs.rename(path.join(caseDir, 'tubs'), path.join(caseDir, 'tubs-2026'));
    expect(await nearestExistingDir(old)).toBe(caseDir);
  });

  it('walks past a FILE squatting on an ancestor name', async () => {
    // caseDir/notes is a file; the stale doc path claims it as a folder.
    await fs.writeFile(path.join(caseDir, 'notes'), 'plain file');
    const stale = path.join(caseDir, 'notes', 'phantom', 'Aff.cmir');
    expect(await nearestExistingDir(stale)).toBe(caseDir);
  });
});

describe('chainDocWrite — per-path serialization', () => {
  it('runs same-path writes strictly in order (no overlap)', async () => {
    const p = docPath();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const first = chainDocWrite(p, async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
    });
    const second = chainDocWrite(p, async () => {
      events.push('second:start');
    });
    // Give the second task every chance to start early if the chain leaked.
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('a failed write does not dam the queue — the next write still runs', async () => {
    const p = docPath();
    const first = chainDocWrite(p, async () => {
      throw new Error('disk on fire');
    });
    const second = chainDocWrite(p, async () => 'ran');
    await expect(first).rejects.toThrow('disk on fire');
    await expect(second).resolves.toBe('ran');
  });

  it('the manual-⌘S-during-autosave interleave: both writes land, last writer wins', async () => {
    const p = await openedDoc();
    await Promise.all([
      saveExistingDoc(p, Buffer.from('autosave bytes')),
      saveExistingDoc(p, Buffer.from('manual save bytes')),
    ]);
    expect(await read(p)).toBe('manual save bytes');
  });
});

describe('rename retry — transiently locked target (Dropbox/antivirus holds)', () => {
  // Field report 2026-07-16 (Windows + Dropbox): the second of two
  // quick saves hit EPERM because Dropbox still held the first save's
  // output for upload. Windows refuses rename-over-open-file; the
  // retry backoff must absorb sub-second holds and mark longer ones
  // with the friendly ELOCKED message.
  it('absorbs transient EPERM on rename and completes the save', async () => {
    const target = docPath('locked.docx');
    await fs.writeFile(target, 'v1');
    await recordDiskStateFromDisk(target);
    const realRename = fs.rename;
    let failures = 2;
    let calls = 0;
    (fs as { rename: typeof fs.rename }).rename = async (a, b) => {
      calls++;
      if (failures-- > 0) {
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realRename(a, b);
    };
    try {
      await saveExistingDoc(target, Buffer.from('v2'));
    } finally {
      (fs as { rename: typeof fs.rename }).rename = realRename;
    }
    expect(calls).toBe(3);
    expect(await fs.readFile(target, 'utf8')).toBe('v2');
  });

  it('exhausted retries throw the friendly ELOCKED error and clean the tmp file', async () => {
    const target = docPath('stuck.docx');
    await fs.writeFile(target, 'v1');
    await recordDiskStateFromDisk(target);
    const realRename = fs.rename;
    (fs as { rename: typeof fs.rename }).rename = async () => {
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    let message = '';
    try {
      await saveExistingDoc(target, Buffer.from('v2'));
    } catch (err) {
      message = (err as Error).message;
    } finally {
      (fs as { rename: typeof fs.rename }).rename = realRename;
    }
    expect(message).toContain(FILE_LOCKED_MARKER);
    expect(message).toContain('temporarily');
    expect(message).toContain('stuck.docx');
    // Old contents intact; tmp sibling cleaned up.
    expect(await fs.readFile(target, 'utf8')).toBe('v1');
    const leftovers = (await fs.readdir(caseDir)).filter((f) => f.includes('cmtmp'));
    expect(leftovers).toEqual([]);
  }, 15000);

  it('non-transient rename errors propagate immediately (no retry loop)', async () => {
    const target = docPath('hard-fail.docx');
    await fs.writeFile(target, 'v1');
    await recordDiskStateFromDisk(target);
    const realRename = fs.rename;
    let calls = 0;
    (fs as { rename: typeof fs.rename }).rename = async () => {
      calls++;
      const err = new Error('EXDEV: cross-device link') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    };
    let message = '';
    try {
      await saveExistingDoc(target, Buffer.from('v2'));
    } catch (err) {
      message = (err as Error).message;
    } finally {
      (fs as { rename: typeof fs.rename }).rename = realRename;
    }
    expect(calls).toBe(1);
    expect(message).toContain('EXDEV');
    expect(message).not.toContain(FILE_LOCKED_MARKER);
  });
});
