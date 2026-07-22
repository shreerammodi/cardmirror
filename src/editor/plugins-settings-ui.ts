/**
 * The Plugins settings tab body: install-from-GitHub field, installed
 * plugin rows (enable / update / uninstall), and the developer
 * load-from-file row. All operations go through the desktop host;
 * off Electron this panel never mounts (category is electronOnly).
 */
import { getElectronHost } from './host/index.js';
import { isPluginEnabled, setPluginEnabled } from './plugins-store.js';
import { confirmDialog } from './text-prompt.js';
import { showToast } from './toast.js';

interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  repo?: string;
}

export function renderPluginsPanel(container: HTMLElement): void {
  const host = getElectronHost();
  if (!host) {
    container.textContent = 'Plugins are available on the desktop app only.';
    return;
  }

  const installRow = document.createElement('div');
  installRow.className = 'pmd-plugins-install';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'GitHub URL or owner/repo';
  const installBtn = document.createElement('button');
  installBtn.textContent = 'Install';
  installRow.append(input, installBtn);

  const list = document.createElement('div');
  list.className = 'pmd-plugins-list';

  const devRow = document.createElement('div');
  const devBtn = document.createElement('button');
  devBtn.textContent = 'Load plugin from file…';
  devRow.append(devBtn);

  container.append(installRow, list, devRow);

  async function refresh(): Promise<void> {
    const plugins = ((await host!.pluginList()) as InstalledPlugin[]) ?? [];
    list.textContent = '';
    if (plugins.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No plugins installed.';
      list.append(empty);
      return;
    }
    for (const p of plugins) {
      const row = document.createElement('div');
      row.className = 'pmd-plugins-row';
      const label = document.createElement('span');
      label.textContent = `${p.name} v${p.version}${p.author ? ` — ${p.author}` : ''}`;
      const enable = document.createElement('input');
      enable.type = 'checkbox';
      enable.checked = isPluginEnabled(p.id);
      enable.addEventListener('change', () => {
        setPluginEnabled(p.id, enable.checked);
        if (enable.checked) {
          void host!.pluginLoad(p.id).then((r) => {
            if (!r.ok) showToast(`${p.name} failed to load: ${r.error ?? 'unknown error'}`);
          });
        } else {
          showToast('Plugin disabled. It stops fully on the next launch.');
        }
      });
      const update = document.createElement('button');
      update.textContent = 'Check for updates';
      update.addEventListener('click', () => {
        void (async () => {
          const res = (await host!.pluginCheckUpdate(p.id, p.repo ?? '')) as
            | { ok: true; latest: string; hasUpdate: boolean }
            | { ok: false; error: string }
            | undefined;
          if (!res || !res.ok) {
            showToast(`Update check failed: ${res && 'error' in res ? res.error : 'unavailable'}`);
            return;
          }
          if (!res.hasUpdate) {
            showToast(`${p.name} is up to date.`);
            return;
          }
          if (await confirmDialog(`Update ${p.name} to v${res.latest}?`)) {
            const r = (await host!.pluginInstall(p.repo ?? '')) as { ok?: boolean } | undefined;
            showToast(r?.ok ? `${p.name} updated. Restart to apply.` : 'Update failed.');
          }
        })();
      });
      const remove = document.createElement('button');
      remove.textContent = 'Uninstall';
      remove.addEventListener('click', () => {
        void (async () => {
          if (!(await confirmDialog(`Uninstall ${p.name}?`))) return;
          await host!.pluginUninstall(p.id);
          setPluginEnabled(p.id, false);
          showToast(`${p.name} uninstalled. Restart to fully unload it.`);
          void refresh();
        })();
      });
      row.append(enable, label, update, remove);
      list.append(row);
    }
  }

  installBtn.addEventListener('click', () => {
    void (async () => {
      const ref = input.value.trim();
      if (!ref) return;
      installBtn.disabled = true;
      try {
        const res = (await host.pluginInstall(ref)) as
          | { ok: true; plugin: InstalledPlugin }
          | { ok: false; error: string }
          | undefined;
        if (!res || !res.ok) {
          showToast(`Install failed: ${res && 'error' in res ? res.error : 'unavailable'}`);
          return;
        }
        const p = res.plugin;
        const consent = await confirmDialog(
          `Install ${p.name} v${p.version}${p.author ? ` by ${p.author}` : ''}? ` +
            'This plugin runs with full access to CardMirror and your documents.',
        );
        if (!consent) {
          await host.pluginUninstall(p.id);
          return;
        }
        setPluginEnabled(p.id, true);
        const r = await host.pluginLoad(p.id);
        showToast(r.ok ? `${p.name} installed and loaded.` : `${p.name} installed; loads on next launch.`);
        input.value = '';
        void refresh();
      } finally {
        installBtn.disabled = false;
      }
    })();
  });

  devBtn.addEventListener('click', () => {
    void (async () => {
      const path = await host.pluginPickFile();
      if (!path) return;
      const r = await host.pluginLoadFile(path);
      showToast(r.ok ? 'Plugin bundle loaded for this session.' : `Load failed: ${r.error ?? 'unknown'}`);
    })();
  });

  void refresh();
}
