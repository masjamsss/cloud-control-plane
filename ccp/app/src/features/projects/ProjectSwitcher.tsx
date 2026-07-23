import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ProjectConfig } from '@/types/project';
import { useProject } from '@/lib/ProjectContext';
import { listProjects } from '@/lib/projectRegistry';
import { apiSessionScopes } from '@/lib/apiSession';

/**
 * Keep only the accounts the signed-in user actually holds a role on. In api
 * mode the server `roles` map is authoritative: an explicit account id, or the
 * `'*'` wildcard (all accounts). An empty scope set is the single-account /
 * mock / legacy posture — no per-account map to filter by, so every registered
 * project stays visible (the previous behavior, unchanged). The ACTIVE project
 * is always kept so a user deep-linked into it never sees an empty switcher.
 */
export function visibleProjects(all: ProjectConfig[], scopes: string[], activeId: string): ProjectConfig[] {
  if (scopes.length === 0 || scopes.includes('*')) return all;
  const allowed = new Set(scopes);
  return all.filter((p) => allowed.has(p.id) || p.id === activeId);
}

/**
 * Header project identity + switcher. Replaces the old static
 * `.shell__project` chip: it still shows the active project's name (and its
 * repo/region on hover) at a glance, but is now a Radix dropdown listing every
 * registered project when there is more than one. Selecting a project does a
 * full navigation to `/p/<id>/` — the simplest correct way to re-run the whole
 * ProjectProvider resolution chain (scope + store namespace) for the new id.
 *
 * Styling reuses AppShell.css's `.shell__project`/`.projswitch__*` rules —
 * already loaded by AppShell.tsx, which is always this component's parent.
 *
 * F-19: the chip's `max-width` + ellipsis can truncate the visible name
 * (six nav items — a lead's full set — crowd it harder than a requester's
 * four, e.g. "Example Est…" at 1,280px). `chipTitle` leads with the full
 * name precisely so a hover always recovers whatever got cut off, ahead of
 * the repo/region detail it already carried.
 */
export function ProjectSwitcher(): JSX.Element {
  const project = useProject();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectConfig[] | null>(null);

  useEffect(() => {
    let alive = true;
    void listProjects().then((list) => {
      // Show only the accounts this user has a role on (api mode); mock/legacy
      // keeps the full list. The active project is always retained.
      if (alive) setProjects(visibleProjects(list, apiSessionScopes(), project.id));
    });
    return () => {
      alive = false;
    };
  }, [project.id]);

  const chipTitle = `${project.name} · ${project.github.owner}/${project.github.repo} · ${project.region}`;

  // Fewer than 2 known projects: either the registry hasn't resolved yet (first
  // paint) or there is genuinely nothing to switch to (spec — hide the
  // switcher entirely). Either way, render the plain identity chip so there is
  // no flash of missing content while listProjects() resolves.
  if (!projects || projects.length <= 1) {
    return (
      <span className="shell__project" title={chipTitle}>
        {project.name}
      </span>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="shell__project shell__project--switcher"
        title={chipTitle}
        aria-label={`Switch project (current: ${project.name})`}
      >
        {project.name}
        <span className="shell__project-caret" aria-hidden="true">
          ▾
        </span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="projswitch__menu" align="start" sideOffset={6}>
          {projects.map((p) => (
            <DropdownMenu.Item
              key={p.id}
              className="projswitch__item"
              onSelect={() => navigate(`/p/${p.id}/`)}
            >
              <span className="projswitch__check" aria-hidden="true">
                {p.id === project.id ? '✓' : ''}
              </span>
              <span className="projswitch__label">
                <span className="projswitch__name">{p.name}</span>
                <span className="projswitch__meta">
                  {p.github.owner}/{p.github.repo} · {p.region}
                </span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default ProjectSwitcher;
