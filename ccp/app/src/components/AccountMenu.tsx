import { useState } from 'react';
import type { JSX } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ROLE_LABEL } from '@/types';
import { useCurrentUser } from '@/lib/session';
import { signOut } from '@/lib/auth';
import { authClient } from '@/lib/api';
import { teamFor } from '@/lib/permissions';
import { useTeams } from '@/lib/teams';
import { getTheme, toggleTheme, type Theme } from '@/lib/theme';
import {
  PALETTES,
  PALETTE_LABELS,
  getPalette,
  isPalette,
  setPalette,
  type Palette,
} from '@/lib/palettes';
import './account-menu.css';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1] ?? '' : '';
  if (!first) return '?';
  if (!last) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

/**
 * The signed-in identity + account actions. Replaces the dev role-switcher:
 * you change seats by signing out, not by flipping a menu.
 *
 * Built on Radix DropdownMenu: roving arrow-key focus, Escape/outside-click
 * dismissal, and focus return to the trigger all come for free — no hand-rolled
 * open state or document listeners.
 */
export function AccountMenu(): JSX.Element {
  // Live — an admin moving you to another team, or granting/revoking
  // your admin capability, updates this menu without a navigation.
  const user = useCurrentUser();
  const teams = useTeams();
  const navigate = useNavigate();
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [palette, setPaletteState] = useState<Palette>(getPalette());

  const teamName = teamFor(user, teams)?.name ?? '—';

  function handleSignOut(): void {
    // Api mode: kill the server session cookie too (fire-and-forget — the local
    // bridge is cleared regardless, and me() re-checks on the next load). No-op in
    // mock mode, where authClient is null.
    void authClient?.logout();
    signOut();
    navigate('/login', { replace: true });
  }

  function handleToggleTheme(): void {
    setThemeState(toggleTheme());
  }

  function handleSetPalette(next: Palette): void {
    setPalette(next);
    setPaletteState(next);
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="acctmenu__trigger">
        <span className="acctmenu__avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
        <span className="acctmenu__id">
          <span className="acctmenu__name">{user.name}</span>
          <span className="acctmenu__role">{ROLE_LABEL[user.role]}</span>
        </span>
        <span className="acctmenu__caret" aria-hidden="true">
          ▾
        </span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="acctmenu__menu" align="end" sideOffset={8}>
          <DropdownMenu.Label className="acctmenu__head">
            <span className="acctmenu__avatar acctmenu__avatar--lg" aria-hidden="true">
              {initials(user.name)}
            </span>
            <span className="acctmenu__head-id">
              <span className="acctmenu__head-name">{user.name}</span>
              <span className="acctmenu__head-sub">
                {ROLE_LABEL[user.role]} · {teamName}
              </span>
            </span>
          </DropdownMenu.Label>

          <DropdownMenu.Item asChild>
            <Link className="acctmenu__item" to="/account">
              <span className="acctmenu__item-glyph" aria-hidden="true">
                ⚿
              </span>
              Account & security
            </Link>
          </DropdownMenu.Item>

          {user.isAdmin && (
            <DropdownMenu.Item asChild>
              <Link className="acctmenu__item" to="/admin">
                <span className="acctmenu__item-glyph" aria-hidden="true">
                  ⛯
                </span>
                Admin
              </Link>
            </DropdownMenu.Item>
          )}

          <DropdownMenu.Item
            className="acctmenu__item"
            onSelect={(e) => {
              // Keep the menu open on toggle so the label + glyph flip in place
              // and the user sees the theme change without reopening.
              e.preventDefault();
              handleToggleTheme();
            }}
          >
            <span className="acctmenu__item-glyph" aria-hidden="true">
              {theme === 'dark' ? '☀' : '☾'}
            </span>
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="acctmenu__separator" />

          <DropdownMenu.Label className="acctmenu__section-label">Palette</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={palette}
            onValueChange={(value) => {
              if (isPalette(value)) handleSetPalette(value);
            }}
          >
            {PALETTES.map((p) => (
              <DropdownMenu.RadioItem
                key={p}
                className="acctmenu__item acctmenu__item--radio"
                value={p}
                // Keep the menu open on selection, same as the theme toggle
                // above — the operator sees the swatch/label state flip in
                // place instead of the menu closing.
                onSelect={(e) => e.preventDefault()}
              >
                <span
                  className="acctmenu__swatch"
                  aria-hidden="true"
                  style={{ background: `var(--palette-swatch-${p})` }}
                />
                {PALETTE_LABELS[p]}
                <DropdownMenu.ItemIndicator className="acctmenu__item-check" aria-hidden="true">
                  ✓
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className="acctmenu__separator" />

          <DropdownMenu.Item className="acctmenu__item" onSelect={handleSignOut}>
            <span className="acctmenu__item-glyph" aria-hidden="true">
              ⏻
            </span>
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default AccountMenu;
