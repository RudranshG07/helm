const KEY = 'helm.session';
const HEADER = 'x-helm-session';

export class NotConnected extends Error {
  constructor() {
    super('This dashboard belongs to a merchant account.');
    this.name = 'NotConnected';
  }
}

export function storedSession(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSession(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    /* a viewer with storage disabled keeps the link instead */
  }
}

export function forgetSession(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}

export function captureSessionFromUrl(): string | null {
  const hash = window.location.hash;
  const match = /(?:^#|&)t=([A-Za-z0-9_-]+)/.exec(hash);
  if (!match) return storedSession();

  const token = match[1]!;
  setSession(token);
  const cleaned = hash.replace(/(?:^#|&)t=[A-Za-z0-9_-]+/, '').replace(/^#&/, '#');
  window.history.replaceState(null, '', window.location.pathname + window.location.search +
    (cleaned === '#' ? '' : cleaned));
  return token;
}

export function sessionHeaders(): Record<string, string> {
  const token = storedSession();
  return token ? { [HEADER]: token } : {};
}

export function dashboardLink(token: string): string {
  return `${window.location.origin}/dashboard#t=${token}`;
}
