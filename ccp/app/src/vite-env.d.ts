/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GITHUB_OWNER?: string;
  readonly VITE_GITHUB_REPO?: string;
  readonly VITE_API_BASE?: string;
  /** Baked instance identity (brand.ts) — empty/unset ⇒ the generic default. */
  readonly VITE_INSTANCE_NAME?: string;
  readonly VITE_INSTANCE_TAGLINE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
