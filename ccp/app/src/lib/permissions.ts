import type { ChangeRequest, ManifestOperation, ServiceManifest, Team, User } from '@/types';
import { approvalsFor, type ApprovalPolicy } from '@/lib/policy';
import { resolveRisk } from '@/lib/riskOverrides';

/** Approvals an operation needs, under the (editable) risk-based approval policy
 * and the operation's effective (possibly overridden) risk level. */
export function approvalsRequiredFor(op: ManifestOperation, policy?: ApprovalPolicy): number {
  return approvalsFor(resolveRisk(op), op.macd, policy);
}

export function teamFor(user: User, teams: Team[]): Team | undefined {
  return teams.find((t) => t.id === user.teamId);
}

/**
 * A requester may only request for their team's services; approvers and leads
 * (seniors) may request for any service.
 */
export function canRequest(user: User, serviceSlug: string, teams: Team[]): boolean {
  if (user.role === 'approver' || user.role === 'lead') return true;
  const team = teamFor(user, teams);
  return team ? team.serviceSlugs.includes(serviceSlug) : false;
}

/**
 * Approvers and leads can approve — but not their own request (separation of
 * duties), and not twice.
 */
export function canApprove(user: User, req: ChangeRequest): boolean {
  if (user.role !== 'approver' && user.role !== 'lead') return false;
  if (req.requester === user.id) return false;
  return !(req.approvals ?? []).some((a) => a.user === user.id);
}

/** Which service slugs the user may actually request for (others are browse-only). */
export function requestableServices(user: User, services: ServiceManifest[], teams: Team[]): Set<string> {
  if (user.role === 'approver' || user.role === 'lead') {
    return new Set(services.map((s) => s.service));
  }
  const team = teamFor(user, teams);
  return new Set(team?.serviceSlugs ?? []);
}
