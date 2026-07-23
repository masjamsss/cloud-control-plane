import type { ConfigStore } from './store/configStore';
import type { AccountItem, SessionItem } from './store/schema';

/** Why a session cookie failed to resolve — maps to a 401 code at the edge. */
export type SessionFail = 'expired' | 'idle' | 'invalid' | 'version' | 'totp';

/** Hono context variables shared across middleware and routes. */
export type AppEnv = {
  Variables: {
    store: ConfigStore;
    projectId: string;
    account?: AccountItem;
    session?: SessionItem;
    sessionFail?: SessionFail;
  };
};
