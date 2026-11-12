import { useState, type ReactNode } from "react";

/** Image with a placeholder fallback (missing file, 404 or SPA fallback HTML). */
export function Art({ src, alt, className, fallback }: { src: string; alt: string; className?: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`art ${className ?? ""}`}>
      {failed ? (
        <div className="art__placeholder" aria-label={alt}>{fallback}</div>
      ) : (
        <img src={src} alt={alt} draggable={false} onError={() => setFailed(true)} />
      )}
    </div>
  );
}
