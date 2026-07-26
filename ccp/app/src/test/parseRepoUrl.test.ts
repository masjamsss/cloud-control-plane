import { describe, expect, it } from 'vitest';
import { parseRepoUrl, suggestProjectId, suggestProjectName } from '@/features/admin/projectsFlow';

/**
 * The url-only register: ONE pasted address becomes the repo reference plus a
 * suggested id and name. The point of these cases is that they are what people
 * actually have in their clipboard — a browser address bar, a clone button, a
 * deep link into a folder — rather than a normalised form we asked them for.
 *
 * Two rules the parser must never break: it DISCARDS a deep link's extra path
 * instead of guessing at it (a `/tree/main/envs/prod` link still means the
 * repository, not a subdirectory project), and it refuses an address with
 * credentials embedded, which would otherwise be stored and displayed.
 */

const ok = (raw: string) => {
  const r = parseRepoUrl(raw);
  if (!r.ok) throw new Error(`expected ${raw} to parse, got: ${r.reason}`);
  return r;
};

describe('parseRepoUrl — what a person actually pastes', () => {
  it.each([
    ['the browser address bar', 'https://github.com/acme-co/terraform-acme'],
    ['the clone button', 'https://github.com/acme-co/terraform-acme.git'],
    ['with a trailing slash', 'https://github.com/acme-co/terraform-acme/'],
    ['no scheme', 'github.com/acme-co/terraform-acme'],
    ['the ssh clone button', 'git@github.com:acme-co/terraform-acme.git'],
    ['ssh with no user', 'github.com:acme-co/terraform-acme'],
    ['the bare shorthand', 'acme-co/terraform-acme'],
    ['surrounding whitespace', '  https://github.com/acme-co/terraform-acme  '],
  ])('%s', (_label, raw) => {
    expect(ok(raw).repo).toEqual({ host: 'github', owner: 'acme-co', name: 'terraform-acme' });
  });

  it('discards a deep link’s viewer path rather than guessing at it', () => {
    for (const raw of [
      'https://github.com/acme-co/terraform-acme/tree/main/envs/prod',
      'https://github.com/acme-co/terraform-acme/blob/main/main.tf',
      'https://github.com/acme-co/terraform-acme/pull/42',
      'https://github.com/acme-co/terraform-acme/commit/abc123',
    ]) {
      expect(ok(raw).repo, raw).toEqual({
        host: 'github',
        owner: 'acme-co',
        name: 'terraform-acme',
      });
    }
  });

  it('recognises gitlab.com by name', () => {
    expect(ok('https://gitlab.com/acme-co/terraform-acme').repo).toEqual({
      host: 'gitlab',
      owner: 'acme-co',
      name: 'terraform-acme',
    });
  });

  it('keeps GitLab subgroups in the owner — they are part of the path', () => {
    expect(ok('https://gitlab.com/acme-co/platform/net/terraform-acme').repo).toEqual({
      host: 'gitlab',
      owner: 'acme-co/platform/net',
      name: 'terraform-acme',
    });
  });

  it('cuts a GitLab deep link at its /-/ UI marker, not at a fixed depth', () => {
    // `/-/` is where GitLab's own UI path starts; everything before it is the
    // project path, however many subgroups deep.
    expect(
      ok('https://gitlab.com/acme-co/platform/terraform-acme/-/blob/main/main.tf').repo,
    ).toEqual({
      host: 'gitlab',
      owner: 'acme-co/platform',
      name: 'terraform-acme',
    });
  });

  it('treats any other host as a self-hosted GitLab — the only self-hosted shape there is', () => {
    expect(ok('https://git.example.internal/acme-co/terraform-acme.git').repo).toEqual({
      host: 'gitlab',
      baseUrl: 'https://git.example.internal',
      owner: 'acme-co',
      name: 'terraform-acme',
    });
  });

  it('REFUSES an address carrying credentials — it would be stored and shown', () => {
    // The host is irrelevant here: the refusal fires before the host is even
    // looked at, so this uses the documentation-reserved domain.
    const r = parseRepoUrl(
      'https://someuser:ghp_exampletokenvalue@example.com/acme-co/terraform-acme.git',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/token/i);
  });

  it('refuses empty input and an address with no owner', () => {
    expect(parseRepoUrl('   ').ok).toBe(false);
    expect(parseRepoUrl('https://github.com/terraform-acme').ok).toBe(false);
    expect(parseRepoUrl('terraform-acme').ok).toBe(false);
  });
});

describe('the suggested id and name are suggestions, not inferences', () => {
  it('drops the estate-repo prefixes that carry no information', () => {
    // Once the repo IS the project, "terraform-" says nothing.
    expect(suggestProjectId('terraform-acme')).toBe('acme');
    expect(suggestProjectId('tf-payments')).toBe('payments');
    expect(suggestProjectId('infra-platform')).toBe('platform');
    expect(suggestProjectId('infrastructure-core')).toBe('core');
  });

  it('produces something the server’s id grammar accepts', () => {
    const GRAMMAR = /^[a-z][a-z0-9-]{1,31}$/;
    for (const repo of [
      'terraform-acme',
      'Acme_Estate',
      'ACME.Platform',
      '2024-estate',
      'a-really-long-repository-name-that-goes-well-past-the-limit',
    ]) {
      expect(suggestProjectId(repo), repo).toMatch(GRAMMAR);
    }
  });

  it('turns the repo name into a readable display name', () => {
    expect(suggestProjectName('terraform-acme')).toBe('Terraform Acme');
    expect(suggestProjectName('payments_platform')).toBe('Payments Platform');
  });

  it('carries both through the parse', () => {
    const r = ok('https://github.com/acme-co/terraform-acme');
    expect(r.suggestedId).toBe('acme');
    expect(r.suggestedName).toBe('Terraform Acme');
  });
});
