const KEY = 'helm.operator';
const HEADER = 'x-helm-operator';

export function storedPassphrase(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(value: string): void {
  try {
    window.sessionStorage.setItem(KEY, value);
  } catch {
    /* a viewer with storage disabled simply retypes it */
  }
}

export function forgetPassphrase(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}

export function operatorHeaders(): Record<string, string> {
  const pass = storedPassphrase();
  return pass ? { [HEADER]: pass } : {};
}

export async function actAsOperator(
  url: string,
  init: RequestInit & { body?: string },
): Promise<Response> {
  const send = (extra: Record<string, string>) =>
    fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...extra, ...(init.headers ?? {}) },
    });

  let response = await send(operatorHeaders());
  if (response.status !== 401) return response;

  const entered = window.prompt(
    'This action can move money, so it needs the operator passphrase.',
  );
  if (entered === null) return response;

  const trimmed = entered.trim();
  response = await send({ [HEADER]: trimmed });
  if (response.ok) remember(trimmed);
  else forgetPassphrase();
  return response;
}
