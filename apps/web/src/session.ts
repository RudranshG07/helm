export class NotConnected extends Error {
  constructor() {
    super('Sign in to see this.');
    this.name = 'NotConnected';
  }
}

export type Credentials =
  | { key_id: string; key_secret: string }
  | { email: string; password: string };

export async function signIn(credentials: Credentials): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const body = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? 'That did not work.');
}

export async function signUp(name: string, email: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });
  const body = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? 'That did not work.');
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}
