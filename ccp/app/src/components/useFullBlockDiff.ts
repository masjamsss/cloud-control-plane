import { useEffect, useState } from 'react';
import type { ManifestOperation } from '@/types';
import { getBlockSource } from '@/lib/blockSource';
import { buildFullBlockDiff, type FullBlockDiff } from '@/lib/blockDiff';

/**
 * Load the full enclosing block for a request's target and compute its
 * before/after diff. Shared by the requester's review and the
 * approver's screens so both see the SAME whole block — the block source is
 * immutable in the bundle and the params are the request's, so the result is
 * deterministic (no need to pin the artifact separately). Returns null while
 * loading, when the address is unknown, or when the op kind can't be expressed
 * as a faithful transform (caller falls back to the parameter diff).
 */
export function useFullBlockDiff(
  op: ManifestOperation | undefined,
  values: Record<string, unknown>,
  targetAddress: string,
): FullBlockDiff | null {
  const [blockDiff, setBlockDiff] = useState<FullBlockDiff | null>(null);
  useEffect(() => {
    let alive = true;
    setBlockDiff(null);
    if (!op) return;
    void getBlockSource(targetAddress).then((block) => {
      if (!alive || !block) return;
      setBlockDiff(buildFullBlockDiff(op, values, block));
    });
    return () => {
      alive = false;
    };
  }, [op, values, targetAddress]);
  return blockDiff;
}
