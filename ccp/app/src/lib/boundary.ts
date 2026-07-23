import { getInstanceIdentity } from '@/lib/instanceIdentity';

/**
 * The out-of-tool boundary: a Day-2 operator's board
 * includes real work that is not a Terraform change — rebooting a host now,
 * running a backup job now, restoring in place. The control plane's credibility depends
 * on naming that boundary plainly instead of absorbing it or answering with
 * silence: an operator who searches "reboot" must learn where reboots live,
 * not find nothing.
 *
 * This module is the single source for that boundary: the static page
 * (features/help/NotInControlPlane.tsx) renders these items, and the command
 * palette (lib/palette.ts) indexes them so ticket words like "reboot" or
 * "run backup now" resolve to the honest answer. {@link boundaryItems} is a
 * FUNCTION (not a module-scope literal) so its `why` copy reads the resolved
 * instance name at call time — no network, no model; the copy is
 * operator-plain and passes the rendered-string copy lint.
 */

export interface BoundaryItem {
  /** Stable id — palette entry identity and the page's list key. */
  id: string;
  /** The ticket shape, in the words a ticket uses. */
  title: string;
  /** Why this is not a control-plane request (one plain line). */
  why: string;
  /** Where the work actually happens. */
  where: string;
  /** Extra ticket vocabulary the palette matches beyond the title. */
  searchTerms: string;
  /** The nearest thing the control plane DOES do, when one exists. */
  nearest?: { label: string; to: string };
}

/** Route for the boundary page (project-scoped by the router's redirect). */
export const BOUNDARY_PAGE_PATH = '/not-in-control-plane';

export function boundaryItems(): BoundaryItem[] {
  return [
  {
    id: 'power',
    title: 'Reboot, stop, or start a server right now',
    why: `${getInstanceIdentity().name} changes how infrastructure is defined, not its live power state.`,
    where: 'Use the operations runbook and the AWS console, and log the action on the ticket.',
    searchTerms:
      'reboot restart bounce stop start shut down shutdown power off power on power cycle turn off turn on instance server now',
  },
  {
    id: 'backup-now',
    title: 'Run a backup right now',
    why: 'Starting a backup job is a console action, not a definition change.',
    where: 'Start the job from the AWS Backup console; its result lands there too.',
    searchTerms:
      'run backup now run a backup backup now on demand backup start backup job immediate backup before a change',
    nearest: {
      label: 'Create a manual database snapshot instead',
      to: '/services/rds/rds-create-manual-snapshot',
    },
  },
  {
    id: 'restore',
    title: 'Restore from a backup in place',
    why: 'Restoring over a live system is a guided console workflow with its own safeguards.',
    where: 'Follow the disaster-recovery runbook with an engineer.',
    searchTerms:
      'restore recover recovery point roll back rollback restore from snapshot restore backup restore database restore volume',
    nearest: {
      label: 'Request a new resource built from a snapshot',
      to: '/services/request-new',
    },
  },
  {
    id: 'os-work',
    title: 'Patch the operating system or grow a disk inside the server',
    why: 'Work inside the operating system runs over Systems Manager, not through infrastructure definitions.',
    where: 'Follow the patching runbook. Growing the underlying volume does start here, in EBS.',
    searchTerms:
      'os patch patching kernel update filesystem file system extend partition grow disk inside the guest resize partition',
    nearest: {
      label: 'Grow a volume (the disk under the server)',
      to: '/services/ebs',
    },
  },
  {
    id: 'lb-targets',
    title: 'Add or remove servers behind the load balancer',
    why: 'Target registration is done in the AWS console when it is not part of the Terraform baseline.',
    where: 'Register or deregister targets in the AWS console, and note it on the ticket.',
    searchTerms:
      'register target deregister target attach instance to target group remove from target group load balancer pool member drain',
  },
  {
    id: 'image',
    title: 'Build a new server image',
    why: 'Images come from the image pipeline, not from an infrastructure request.',
    where: 'Follow the image pipeline runbook.',
    searchTerms: 'ami image bake baking golden image build image machine image',
  },
  ];
}
