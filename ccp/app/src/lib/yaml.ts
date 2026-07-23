import yaml from 'js-yaml';
import type { ChangeRequest } from '@/types';

/**
 * Serialize a request to the YAML record the backend would commit as
 * `requests/REQ-<ulid>.yaml` (evidence artifact #1). Deterministic, ordered.
 */
export function requestToYaml(req: ChangeRequest): string {
  return yaml.dump(req, { noRefs: true, lineWidth: 100, sortKeys: false });
}
