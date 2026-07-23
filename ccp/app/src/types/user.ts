/** The three roles in the control plane. */
export type Role = 'requester' | 'approver' | 'lead';

export const ROLE_LABEL: Record<Role, string> = {
  requester: 'Requester',
  approver: 'Approver',
  lead: 'Lead',
};

/** A team owns a set of services its requesters may request changes for. */
export interface Team {
  id: string;
  name: string;
  serviceSlugs: string[];
}

export interface User {
  id: string;
  name: string;
  role: Role;
  teamId: string;
  /** Governance capability, separate from approval power: admins
   * control settings/users/policy. A Lead is not automatically an admin. */
  isAdmin?: boolean;
}
