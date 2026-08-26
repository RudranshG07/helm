export function rupees(paise: number): string {
  const value = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

export function ist(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));
}

export function relativeDays(days: number | null): string {
  if (days === null) return 'no expiry';
  if (days < 0) return 'expired';
  if (days === 0) return 'expires today';
  return `${days}d to expiry`;
}
