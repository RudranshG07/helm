export function SkeletonReport() {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <div className="skeleton title-shape" />
      <div className="skeleton line-shape medium" />
      <div className="skeleton line-shape short" />
      <div className="skeleton-tiles spaced">
        <div className="skeleton tile-shape" />
        <div className="skeleton tile-shape" />
        <div className="skeleton tile-shape" />
      </div>
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <div className="skeleton row-shape is-faint" />
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton row-shape" key={i} />
      ))}
    </div>
  );
}

export function SkeletonDoc() {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <div className="skeleton title-shape" />
      <div className="skeleton line-shape" />
      <div className="skeleton line-shape medium" />
      <div className="skeleton-tiles spaced-lg">
        <div className="skeleton tile-shape" />
        <div className="skeleton tile-shape" />
        <div className="skeleton tile-shape" />
      </div>
      <div className="skeleton row-shape spaced-lg" />
      <div className="skeleton row-shape" />
      <div className="skeleton row-shape" />
    </div>
  );
}

export function Announce({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="visually-hidden" role="status">{label}</span>
      {children}
    </>
  );
}
