import React, { useCallback, useEffect, useState } from 'react';
import {
  LocalBrowseDir,
  LocalStatus,
  ProjectConfig,
  api,
  getStoredToken,
} from '../../api/client';

interface LocalModeModalProps {
  open: boolean;
  runtimeMode: string;
  loggedIn: boolean;
  onClose: () => void;
  onStatusMessage: (msg: string) => void;
  onLocalWorkspaceChanged: (selectProjectId?: string) => Promise<void>;
}

export const LocalModeModal: React.FC<LocalModeModalProps> = ({
  open,
  runtimeMode,
  loggedIn,
  onClose,
  onStatusMessage,
  onLocalWorkspaceChanged,
}) => {
  // Hosted Setup Wizard state
  const [projectsInput, setProjectsInput] = useState('~/dupe_projects');
  const [autostart, setAutostart] = useState(true);
  const [syncWithServer, setSyncWithServer] = useState(true);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [localReachable, setLocalReachable] = useState(false);
  const [checkingLocal, setCheckingLocal] = useState(false);

  // Local Mode Folder Browser & Symlink Linker state
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [homeDir, setHomeDir] = useState('');
  const [dirs, setDirs] = useState<LocalBrowseDir[]>([]);
  const [loadingBrowse, setLoadingBrowse] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [selectedSourceDir, setSelectedSourceDir] = useState<string>('');
  const [linkProjectName, setLinkProjectName] = useState('');
  const [linkMode, setLinkMode] = useState<'symlink_paper' | 'symlink_project'>('symlink_paper');
  const [submittingAction, setSubmittingAction] = useState(false);

  const isLocalMode = runtimeMode === 'local';

  const checkLocalDaemon = useCallback(async () => {
    setCheckingLocal(true);
    try {
      const resp = await fetch('http://127.0.0.1:8080/api/health', { mode: 'cors' });
      if (resp.ok) {
        const data = (await resp.json()) as { mode?: string };
        setLocalReachable(data.mode === 'local');
      } else {
        setLocalReachable(false);
      }
    } catch {
      setLocalReachable(false);
    } finally {
      setCheckingLocal(false);
    }
  }, []);

  const loadLocalBrowse = useCallback(async (targetPath?: string) => {
    setLoadingBrowse(true);
    setBrowseError(null);
    try {
      const res = await api.localBrowse(targetPath);
      setCurrentPath(res.current_path);
      setParentPath(res.parent_path);
      setHomeDir(res.home_dir);
      setDirs(res.dirs || []);
      setSelectedSourceDir(res.current_path);
      const base = res.current_path.split('/').filter(Boolean).pop() || '';
      setLinkProjectName((prev) => prev || base);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Failed to browse directory');
    } finally {
      setLoadingBrowse(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    if (!isLocalMode) {
      void checkLocalDaemon();
      const timer = window.setInterval(() => void checkLocalDaemon(), 2500);
      return () => window.clearInterval(timer);
    }

    void api
      .localStatus()
      .then((st) => {
        setLocalStatus(st);
        return loadLocalBrowse(st.projects_dir || st.home_dir);
      })
      .catch(() => void loadLocalBrowse());
    return undefined;
  }, [open, isLocalMode, checkLocalDaemon, loadLocalBrowse]);

  if (!open) {
    return null;
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://dupe.ing';
  const token = getStoredToken() || '<YOUR_TOKEN>';
  const setupPath = api.localSetupUrl({
    projects: projectsInput.trim() || '~/dupe_projects',
    autostart,
    sync: loggedIn && syncWithServer,
  });
  const installCommand = loggedIn
    ? `curl -fsSL -H "Authorization: Bearer ${token}" "${origin}${setupPath}" | bash`
    : 'Sign in above first so this command includes your sync token automatically.';

  const handleNativeFolderHint = async () => {
    const picker = (window as unknown as { showDirectoryPicker?: () => Promise<{ name: string }> })
      .showDirectoryPicker;
    if (!picker) {
      onStatusMessage('Browser native folder picker unavailable here — type a path like ~/mimic_projects.');
      return;
    }
    try {
      const handle = await picker();
      if (handle?.name) {
        setProjectsInput(`~/${handle.name}`);
      }
    } catch {
      // user canceled
    }
  };

  const handleSetRoot = async (targetDir: string) => {
    setSubmittingAction(true);
    try {
      const res = await api.setLocalProjectsRoot(targetDir);
      const st = await api.localStatus();
      setLocalStatus(st);
      await onLocalWorkspaceChanged();
      onStatusMessage(`Local projects folder set to ${res.projects_dir}`);
      onClose();
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Failed to update projects folder');
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleLinkFolder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedSourceDir.trim()) {
      return;
    }
    setSubmittingAction(true);
    setBrowseError(null);
    try {
      const created: ProjectConfig = await api.linkLocalFolder({
        name: linkProjectName.trim() || selectedSourceDir.split('/').filter(Boolean).pop() || 'Project',
        source_path: selectedSourceDir.trim(),
        link_mode: linkMode,
      });
      await onLocalWorkspaceChanged(created.id);
      onStatusMessage(`Linked local folder ${selectedSourceDir} as project "${created.name}".`);
      onClose();
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Failed to link local folder');
    } finally {
      setSubmittingAction(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="local-wizard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <strong>
              {isLocalMode
                ? '📁 Local Mode Folder & Project Guide'
                : '💻 Run dupe Locally on Your Machine'}
            </strong>
            <div className="muted-hint">
              {isLocalMode
                ? 'Choose where dupe stores projects or symlink an existing folder on your laptop.'
                : 'Edit local files, use symlinks & VS Code agents offline, and sync your PDF library.'}
            </div>
          </div>
          <button type="button" className="btn-tiny" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        {!isLocalMode ? (
          <div className="modal-body">
            <div className="wizard-step-card">
              <div className="wizard-step-title">Step 1 — Choose Your Local Projects Folder</div>
              <p className="muted-hint">
                Pick the folder on your laptop where local projects live (e.g. Mimic, research papers, or symlinks).
              </p>
              <div className="row-gap">
                <input
                  type="text"
                  value={projectsInput}
                  onChange={(e) => setProjectsInput(e.target.value)}
                  placeholder="~/dupe_projects"
                />
                <button type="button" className="btn-tiny" onClick={() => void handleNativeFolderHint()}>
                  Browse Name…
                </button>
              </div>
              <div className="row-gap" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                {['~/dupe_projects', '~/mimic_projects', '~/research'].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={`tag-pill ${projectsInput === preset ? 'active' : ''}`}
                    onClick={() => setProjectsInput(preset)}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <div className="row-gap" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={autostart}
                    onChange={(e) => setAutostart(e.target.checked)}
                  />
                  Always run in background (Linux systemd user service)
                </label>
                {loggedIn && (
                  <label className="checkbox-inline">
                    <input
                      type="checkbox"
                      checked={syncWithServer}
                      onChange={(e) => setSyncWithServer(e.target.checked)}
                    />
                    Sync PDF library with {origin}
                  </label>
                )}
              </div>
            </div>

            <div className="wizard-step-card">
              <div className="wizard-step-title">
                Step 2 — Install Binary, Tectonic &amp; Start Local Server
              </div>
              <p className="muted-hint">
                Run this single command in a terminal on your laptop (installs into <code>~/.local/share/dupe</code> and starts port <code>8080</code>):
              </p>
              <pre className="md-pre" style={{ userSelect: 'all', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {installCommand}
              </pre>
              <div className="row-gap" style={{ flexWrap: 'wrap' }}>
                {loggedIn && (
                  <>
                    <button
                      type="button"
                      className="btn-primary btn-tiny"
                      onClick={() => {
                        void navigator.clipboard?.writeText(installCommand);
                        setCopiedCmd(true);
                        window.setTimeout(() => setCopiedCmd(false), 2000);
                      }}
                    >
                      {copiedCmd ? '✓ Copied Command' : '📋 Copy Install Command'}
                    </button>
                    <a href={api.localBundleUrl()} className="btn-tiny">
                      ⬇ Download Binary Bundle (.tar.gz)
                    </a>
                  </>
                )}
              </div>
            </div>

            <div className="wizard-step-card">
              <div className="wizard-step-title">Step 3 — Open Local Studio</div>
              <div className="row-gap" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <span className={localReachable ? 'online-pill online' : 'online-pill offline'}>
                  {localReachable
                    ? '● Local dupe detected on http://127.0.0.1:8080'
                    : checkingLocal
                      ? 'Checking http://127.0.0.1:8080…'
                      : 'Waiting for local dupe on http://127.0.0.1:8080'}
                </span>
                <div className="row-gap">
                  <button type="button" className="btn-tiny" onClick={() => void checkLocalDaemon()}>
                    ↻ Re-check
                  </button>
                  <a
                    href="http://127.0.0.1:8080"
                    className={`btn-tiny ${localReachable ? 'btn-primary' : ''}`}
                  >
                    Open Local Studio (127.0.0.1:8080) →
                  </a>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="modal-body">
            {localStatus && (
              <div className="local-env-pills">
                <span className="online-pill online">Projects Root: {localStatus.projects_dir}</span>
                <span className={`online-pill ${localStatus.tectonic_available ? 'online' : 'offline'}`}>
                  {localStatus.tectonic_available ? '✓ Tectonic Ready' : '⚠ Tectonic Missing'}
                </span>
                <span className={`online-pill ${localStatus.python_available ? 'online' : 'offline'}`}>
                  {localStatus.python_available ? '✓ Python Ready' : '⚠ Python Missing'}
                </span>
                {localStatus.sync_remote_url && (
                  <span className="online-pill online">↻ Sync: {localStatus.sync_remote_url}</span>
                )}
              </div>
            )}

            {browseError && <div className="auth-error">{browseError}</div>}

            <div className="wizard-step-card">
              <div className="row-gap" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <div className="wizard-step-title" style={{ marginBottom: 0 }}>
                  Browse Folders on This Machine
                </div>
                <div className="row-gap">
                  {parentPath && (
                    <button
                      type="button"
                      className="btn-tiny"
                      onClick={() => void loadLocalBrowse(parentPath)}
                    >
                      ↑ Up
                    </button>
                  )}
                  {homeDir && (
                    <button
                      type="button"
                      className="btn-tiny"
                      onClick={() => void loadLocalBrowse(homeDir)}
                    >
                      🏠 Home
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-tiny"
                    disabled={submittingAction || !currentPath}
                    onClick={() => void handleSetRoot(currentPath)}
                  >
                    ✓ Use as Projects Root
                  </button>
                </div>
              </div>
              <div className="row-gap" style={{ marginTop: 6 }}>
                <input
                  type="text"
                  value={selectedSourceDir}
                  onChange={(e) => setSelectedSourceDir(e.target.value)}
                  placeholder="/path/to/folder"
                />
                <button
                  type="button"
                  className="btn-tiny"
                  onClick={() => void loadLocalBrowse(selectedSourceDir)}
                >
                  Open
                </button>
              </div>
              <div className="browse-dir-list">
                {loadingBrowse ? (
                  <div className="muted-hint" style={{ padding: 10 }}>Loading directories…</div>
                ) : dirs.length === 0 ? (
                  <div className="muted-hint" style={{ padding: 10 }}>No subfolders in {currentPath}.</div>
                ) : (
                  dirs.map((d) => (
                    <div
                      key={d.path}
                      className={`browse-dir-row ${selectedSourceDir === d.path ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedSourceDir(d.path);
                        setLinkProjectName(d.name);
                      }}
                      onDoubleClick={() => void loadLocalBrowse(d.path)}
                    >
                      <span>📁 {d.name}</span>
                      <div className="row-gap">
                        {d.is_dupe_project && <span className="git-badge git-badge-u">dupe</span>}
                        {d.has_tex && <span className="git-badge git-badge-m">LaTeX</span>}
                        {d.has_git && <span className="folder-count">git</span>}
                        <button
                          type="button"
                          className="tree-action-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void loadLocalBrowse(d.path);
                          }}
                        >
                          Open →
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <form className="wizard-step-card" onSubmit={(e) => void handleLinkFolder(e)}>
              <div className="wizard-step-title">
                Link Existing Folder Without Moving Files (Symlink)
              </div>
              <div className="row-gap" style={{ flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="Project Name (e.g. dinoMimic)"
                  value={linkProjectName}
                  onChange={(e) => setLinkProjectName(e.target.value)}
                  required
                  style={{ flex: 1, minWidth: 180 }}
                />
                <select
                  value={linkMode}
                  onChange={(e) =>
                    setLinkMode(e.target.value as 'symlink_paper' | 'symlink_project')
                  }
                  style={{ flex: 1, minWidth: 220 }}
                >
                  <option value="symlink_paper">
                    Symlink selected folder as paper/ (keep notes/diagrams separate)
                  </option>
                  <option value="symlink_project">
                    Symlink entire selected folder as a dupe project
                  </option>
                </select>
                <button type="submit" className="btn-primary btn-tiny" disabled={submittingAction}>
                  🔗 Link &amp; Open
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
