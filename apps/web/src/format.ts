export function rupees(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export function compactRupees(paise: number): string {
  const value = paise / 100;
  if (value >= 10_000_000) return `₹${(value / 10_000_000).toFixed(2)} Cr`;
  if (value >= 100_000) return `₹${(value / 100_000).toFixed(2)} L`;
  return rupees(paise);
}

export function ist(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));
}

export function sinceNow(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function expiry(days: number | null): string {
  if (days === null) return 'no expiry';
  if (days < 0) return 'expired';
  if (days === 0) return 'expires today';
  if (days === 1) return '1 day left';
  return `${days} days left`;
}

export function humanAction(action: string): string {
  return action.toLowerCase().replace(/_/g, ' ');
}

export function humanMethod(method: string): string {
  if (method === 'upi_autopay') return 'UPI Autopay';
  if (method === 'emandate') return 'e-mandate';
  return method;
}

export function bucketLabel(bucket: string | null | undefined): string {
  if (!bucket) return 'unclassified';
  return bucket.toLowerCase().replace(/_/g, ' ');
}
