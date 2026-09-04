import { useEffect, useRef } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';

export function useReveal<T extends HTMLElement>(selector: string, deps: unknown[] = []) {
  const root = useRef<T | null>(null);

  useEffect(() => {
    const node = root.current;
    if (!node) return;

    const targets = Array.from(node.querySelectorAll<HTMLElement>(selector));
    if (targets.length === 0) return;

    if (typeof window === 'undefined'
      || !('IntersectionObserver' in window)
      || window.matchMedia(REDUCED).matches) {
      for (const t of targets) t.dataset['revealed'] = 'true';
      return;
    }

    for (const t of targets) {
      if (t.dataset['revealed'] !== 'true') t.dataset['reveal'] = 'pending';
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        el.dataset['revealed'] = 'true';
        delete el.dataset['reveal'];
        observer.unobserve(el);
      }
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

    for (const t of targets) {
      if (t.dataset['revealed'] === 'true') continue;
      observer.observe(t);
    }

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return root;
}
