import { isPeak, toIstParts } from './time.ts';

export interface ScheduledDebit {
  id: string;
  merchant_id: string;
  customer_key: string;
  amount_paise: number;
  at: Date;
  earliest: Date;
  latest: Date;
}

export interface Collision {
  customer_key: string;
  at: Date;
  debits: string[];
  total_paise: number;
}

export const COLLISION_WINDOW_MS = 30 * 60_000;
export const SPACING_MS = 90 * 60_000;

export function findCollisions(
  debits: ScheduledDebit[],
  windowMs = COLLISION_WINDOW_MS,
): Collision[] {
  const byCustomer = new Map<string, ScheduledDebit[]>();
  for (const d of debits) {
    const list = byCustomer.get(d.customer_key) ?? [];
    list.push(d);
    byCustomer.set(d.customer_key, list);
  }

  const collisions: Collision[] = [];

  for (const [customer, list] of byCustomer) {
    const sorted = [...list].sort((a, b) => a.at.getTime() - b.at.getTime());
    let group: ScheduledDebit[] = [];

    const flush = () => {
      if (group.length > 1) {
        collisions.push({
          customer_key: customer,
          at: group[0]!.at,
          debits: group.map((d) => d.id),
          total_paise: group.reduce((s, d) => s + d.amount_paise, 0),
        });
      }
      group = [];
    };

    for (const d of sorted) {
      if (group.length === 0) {
        group = [d];
        continue;
      }
      if (d.at.getTime() - group[0]!.at.getTime() <= windowMs) group.push(d);
      else {
        flush();
        group = [d];
      }
    }
    flush();
  }

  return collisions;
}

export interface Assignment {
  id: string;
  original_at: Date;
  assigned_at: Date;
  moved_ms: number;
  moved: boolean;
  reason: string;
}

export interface DeconflictResult {
  assignments: Assignment[];
  collisions_before: number;
  collisions_after: number;
  debits_moved: number;
  unresolvable: string[];
}

function nextLegalSlot(from: Date, latest: Date, stepMs: number): Date | null {
  let at = new Date(from.getTime());
  for (let i = 0; i < 400; i += 1) {
    if (at > latest) return null;
    if (!isPeak(at)) return at;
    at = new Date(at.getTime() + stepMs);
  }
  return null;
}

export function deconflict(
  debits: ScheduledDebit[],
  spacingMs = SPACING_MS,
  windowMs = COLLISION_WINDOW_MS,
): DeconflictResult {
  const before = findCollisions(debits, windowMs);

  const byCustomer = new Map<string, ScheduledDebit[]>();
  for (const d of debits) {
    const list = byCustomer.get(d.customer_key) ?? [];
    list.push(d);
    byCustomer.set(d.customer_key, list);
  }

  const assignments: Assignment[] = [];
  const resolved: ScheduledDebit[] = [];
  const unresolvable: string[] = [];

  for (const [, list] of byCustomer) {
    const ordered = [...list].sort(
      (a, b) => b.amount_paise - a.amount_paise || a.at.getTime() - b.at.getTime(),
    );
    const taken: Date[] = [];

    for (const d of ordered) {
      const conflicts = (at: Date) =>
        taken.some((t) => Math.abs(t.getTime() - at.getTime()) < spacingMs);

      let candidate = nextLegalSlot(d.at, d.latest, 30 * 60_000);
      let guard = 0;

      while (candidate && conflicts(candidate) && guard < 200) {
        guard += 1;
        candidate = nextLegalSlot(
          new Date(candidate.getTime() + spacingMs),
          d.latest,
          30 * 60_000,
        );
      }

      if (!candidate) {
        unresolvable.push(d.id);
        assignments.push({
          id: d.id,
          original_at: d.at,
          assigned_at: d.at,
          moved: false,
          moved_ms: 0,
          reason: 'No legal slot inside this mandate\'s own window is free of a collision.',
        });
        resolved.push(d);
        continue;
      }

      taken.push(candidate);
      const movedMs = candidate.getTime() - d.at.getTime();
      assignments.push({
        id: d.id,
        original_at: d.at,
        assigned_at: candidate,
        moved: movedMs !== 0,
        moved_ms: movedMs,
        reason:
          movedMs === 0
            ? 'Already clear of every other debit on this customer.'
            : `Moved ${Math.round(movedMs / 60_000)} minutes to clear ${taken.length - 1} other ` +
              'debit(s) landing on the same account.',
      });
      resolved.push({ ...d, at: candidate });
    }
  }

  const after = findCollisions(resolved, windowMs);

  return {
    assignments,
    collisions_before: before.length,
    collisions_after: after.length,
    debits_moved: assignments.filter((a) => a.moved).length,
    unresolvable,
  };
}

export function describeWindow(at: Date): string {
  const p = toIstParts(at);
  return `${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} IST`;
}
