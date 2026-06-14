export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'unknown';

// Coarse ref classification. The raw branch/tag name is deliberately NOT sent on
// the wire (names leak feature/project info); this enum is the privacy-safe
// signal for "runs on the default branch vs a feature branch vs a tag".
export type RefKind = 'default-branch' | 'branch' | 'tag' | 'unknown';

export interface RepoContextInput {
  repoUrl?: string;
  repoSlug?: string;
  gitProvider?: string;
  ref?: string;
  sha?: string;
}

export interface RepoContext {
  provider: GitProvider;
  repoUrl?: string;
  repoSlug?: string;
  ref?: string;
  sha?: string;
  refKind: RefKind;
}

function normalize(value?: string): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRepoUrl(url?: string): string | undefined {
  const raw = normalize(url);
  if (!raw) {
    return undefined;
  }

  const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2];
    return `https://${host}/${path}`;
  }

  return raw.replace(/\.git$/, '');
}

function parseProvider(
  explicitProvider: string | undefined,
  repoUrl: string | undefined,
  env: NodeJS.ProcessEnv
): GitProvider {
  const explicit = normalize(explicitProvider)?.toLowerCase();
  if (explicit === 'github' || explicit === 'gitlab' || explicit === 'bitbucket' || explicit === 'azure-devops') {
    return explicit;
  }

  const url = (repoUrl ?? '').toLowerCase();
  if (url.includes('github')) {
    return 'github';
  }
  if (url.includes('gitlab')) {
    return 'gitlab';
  }
  if (url.includes('bitbucket')) {
    return 'bitbucket';
  }
  if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) {
    return 'azure-devops';
  }

  if (normalize(env.GITHUB_REPOSITORY)) {
    return 'github';
  }
  if (normalize(env.CI_PROJECT_PATH) || normalize(env.GITLAB_CI)) {
    return 'gitlab';
  }
  if (normalize(env.BITBUCKET_REPO_SLUG)) {
    return 'bitbucket';
  }
  if (normalize(env.BUILD_REPOSITORY_URI)) {
    return 'azure-devops';
  }

  return 'unknown';
}

// Classify the ref as default-branch / branch / tag without ever emitting the
// name. Tag detection keys on the contractual per-provider signals; the
// default-branch test compares the resolved ref to the provider's
// default-branch env. When neither proves out, fall back conservatively to
// 'branch' (we are on a ref of some kind) or 'unknown' (no ref resolved).
export function classifyRefKind(env: NodeJS.ProcessEnv = process.env): RefKind {
  // Tag signals, most-specific first.
  const githubRefType = normalize(env.GITHUB_REF_TYPE)?.toLowerCase();
  const githubRef = normalize(env.GITHUB_REF);
  const azureRef = normalize(env.BUILD_SOURCEBRANCH);
  if (
    githubRefType === 'tag' ||
    githubRef?.startsWith('refs/tags/') ||
    normalize(env.CI_COMMIT_TAG) ||
    normalize(env.BITBUCKET_TAG) ||
    azureRef?.startsWith('refs/tags/')
  ) {
    return 'tag';
  }

  // Default-branch test: only assert it when the provider hands us both the
  // current ref and its own notion of the default, and they match.
  const githubRefName = normalize(env.GITHUB_REF_NAME);
  const githubDefault = normalize(env.GITHUB_DEFAULT_BRANCH);
  if (githubRefName && githubDefault) {
    return githubRefName === githubDefault ? 'default-branch' : 'branch';
  }
  const gitlabRef = normalize(env.CI_COMMIT_REF_NAME);
  const gitlabDefault = normalize(env.CI_DEFAULT_BRANCH);
  if (gitlabRef && gitlabDefault) {
    return gitlabRef === gitlabDefault ? 'default-branch' : 'branch';
  }

  // A ref is present but we cannot prove it is the default -> 'branch'.
  if (
    githubRefName ||
    githubRef?.startsWith('refs/heads/') ||
    gitlabRef ||
    normalize(env.BITBUCKET_BRANCH) ||
    normalize(env.BUILD_SOURCEBRANCHNAME) ||
    azureRef?.startsWith('refs/heads/')
  ) {
    return 'branch';
  }

  return 'unknown';
}

export function detectRepoContext(
  input: RepoContextInput,
  env: NodeJS.ProcessEnv = process.env
): RepoContext {
  const repoUrl =
    normalizeRepoUrl(input.repoUrl) ??
    normalizeRepoUrl(env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}` : undefined) ??
    normalizeRepoUrl(env.CI_PROJECT_URL) ??
    normalizeRepoUrl(env.BITBUCKET_GIT_HTTP_ORIGIN) ??
    normalizeRepoUrl(env.BUILD_REPOSITORY_URI);
  const repoSlug =
    normalize(input.repoSlug) ??
    normalize(env.GITHUB_REPOSITORY) ??
    normalize(env.CI_PROJECT_PATH) ??
    (env.BITBUCKET_WORKSPACE && env.BITBUCKET_REPO_SLUG
      ? normalize(`${env.BITBUCKET_WORKSPACE}/${env.BITBUCKET_REPO_SLUG}`)
      : undefined) ??
    normalize(env.BUILD_REPOSITORY_NAME);
  const ref =
    normalize(input.ref) ??
    normalize(env.GITHUB_REF_NAME) ??
    normalize(env.CI_COMMIT_REF_NAME) ??
    normalize(env.BITBUCKET_BRANCH) ??
    normalize(env.BUILD_SOURCEBRANCHNAME);
  const sha =
    normalize(input.sha) ??
    normalize(env.GITHUB_SHA) ??
    normalize(env.CI_COMMIT_SHA) ??
    normalize(env.BITBUCKET_COMMIT) ??
    normalize(env.BUILD_SOURCEVERSION);
  const provider = parseProvider(input.gitProvider, repoUrl, env);
  const refKind = classifyRefKind(env);

  return {
    provider,
    repoUrl,
    repoSlug,
    ref,
    sha,
    refKind
  };
}
