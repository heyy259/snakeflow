import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { removeFileBestEffort } from '../resilientFs.js';

const DEFAULT_DIALOG_FILTER = 'JSON (*.json)|*.json';

function psQuote(s) {
  return String(s == null ? '' : s).replace(/'/g, "''");
}

function sanitizeDialogFilter(raw) {
  if (typeof raw !== 'string') return DEFAULT_DIALOG_FILTER;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_DIALOG_FILTER;
  if (!trimmed.includes('|')) return DEFAULT_DIALOG_FILTER;
  if (/[\r\n'"`$]/.test(trimmed)) return DEFAULT_DIALOG_FILTER;
  if (!/^[\w\s().*;:\\/,\-|一-鿿]+$/.test(trimmed)) return DEFAULT_DIALOG_FILTER;
  return trimmed;
}

function sanitizeDialogName(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/[\r\n'"`$;]/.test(trimmed)) return '';
  return trimmed;
}

function buildDialogScript(kind, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const filter = sanitizeDialogFilter(o.filter);
  const defaultName = sanitizeDialogName(o.defaultName);
  const fallbackTitle = kind === 'save' ? '保存图 (Save graph)' : '打开图 (Open graph)';
  const title = sanitizeDialogName(o.title) || fallbackTitle;
  const dialogType = kind === 'save' ? 'SaveFileDialog' : 'OpenFileDialog';
  let script =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    `$d = New-Object System.Windows.Forms.${dialogType}; ` +
    `$d.Filter = '${psQuote(filter)}'; ` +
    `$d.Title = '${psQuote(title)}'; `;
  if (defaultName) {
    script += `$d.FileName = '${psQuote(defaultName)}'; `;
  }
  script +=
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ' +
    "[System.IO.File]::WriteAllText('__TMP__', $d.FileName, (New-Object System.Text.UTF8Encoding($false))) }";
  return script;
}

export function parseDialogOpts(text) {
  let parsed;
  try {
    parsed = JSON.parse(text) || {};
  } catch (err) {
    return {};
  }
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function runWindowsDialog(kind, opts) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `rf-dialog-${process.pid}-${Date.now()}.txt`);
    const script = buildDialogScript(kind, opts).replace('__TMP__', tmp.replace(/'/g, "''"));
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], (err) => {
      let result = null;
      if (!err && fs.existsSync(tmp)) {
        result = fs.readFileSync(tmp, 'utf-8').trim() || null;
      }
      removeFileBestEffort(tmp);
      resolve(result);
    });
  });
}

function osaQuote(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runMacDialog(kind, opts) {
  return new Promise((resolve) => {
    const title = sanitizeDialogName(opts && opts.title) || (kind === 'save' ? 'Save graph' : 'Open graph');
    const defaultName = sanitizeDialogName(opts && opts.defaultName) || 'graph.se.json';
    const script = kind === 'save'
      ? `POSIX path of (choose file name with prompt "${osaQuote(title)}" default name "${osaQuote(defaultName)}")`
      : `POSIX path of (choose file with prompt "${osaQuote(title)}")`;
    execFile('osascript', ['-e', script], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(String(stdout || '').trim() || null);
    });
  });
}

function runLinuxDialog(kind, opts) {
  return new Promise((resolve) => {
    const title = sanitizeDialogName(opts && opts.title) || (kind === 'save' ? 'Save graph' : 'Open graph');
    const defaultName = sanitizeDialogName(opts && opts.defaultName) || 'graph.se.json';
    const args = kind === 'save'
      ? ['--file-selection', '--save', `--title=${title}`, `--filename=${defaultName}`]
      : ['--file-selection', `--title=${title}`];
    execFile('zenity', args, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(String(stdout || '').trim() || null);
    });
  });
}

export function runDialog(kind, opts) {
  if (process.platform === 'win32') return runWindowsDialog(kind, opts);
  if (process.platform === 'darwin') return runMacDialog(kind, opts);
  return runLinuxDialog(kind, opts);
}
