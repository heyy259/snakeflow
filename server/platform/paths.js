const WINDOWS_EXEC_EXTS = ['.exe', '.bat', '.cmd', '.ps1', '.lnk', '.msi', '.scr', '.com', '.vbs', '.dll'];
const POSIX_EXEC_EXTS = ['.app', '.command', '.sh', '.bash', '.zsh', '.run', '.bin'];

export const EXEC_EXTS = new Set([...WINDOWS_EXEC_EXTS, ...POSIX_EXEC_EXTS]);

export function isAbsolutePath(input) {
  const raw = String(input == null ? '' : input).replace(/\\/g, '/').trim();
  return /^[A-Za-z]:\//.test(raw) || raw.startsWith('//') || raw.startsWith('/');
}
