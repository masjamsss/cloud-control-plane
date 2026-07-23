import type { JSX } from 'react';
import { getServiceMeta } from '@/lib/serviceMeta';
import { CATEGORY_ICON_CLASS, SERVICE_GLYPHS } from '@/lib/serviceIcons';
import './svc-icon.css';

export interface ServiceIconProps {
  slug: string;
  /** Tile edge in px. */
  size?: number;
}

/**
 * A service's identity tile — a category-tinted rounded square with its own
 * glyph (falls back to the two-letter monogram when a glyph isn't defined yet).
 * The tint is the "service identity" axis, never a status signal.
 */
export function ServiceIcon({ slug, size = 32 }: ServiceIconProps): JSX.Element {
  const meta = getServiceMeta(slug);
  const cat = CATEGORY_ICON_CLASS[meta.category];
  const glyph = SERVICE_GLYPHS[slug];
  const style = { width: size, height: size } as React.CSSProperties;

  return (
    <span className={`svc-icon svc-icon--${cat}`} style={style} aria-hidden="true">
      {glyph ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="svc-icon__glyph"
          dangerouslySetInnerHTML={{ __html: glyph }}
        />
      ) : (
        <span className="svc-icon__mono">{meta.monogram}</span>
      )}
    </span>
  );
}

export default ServiceIcon;
