import { render } from '@solidjs/testing-library';
import type { JSX } from 'solid-js';
import { RepoProvider } from './db/context';
import type { Repo } from './db/api';

export function renderWithRepo(ui: () => JSX.Element, repo: Repo) {
  return render(() => <RepoProvider repo={repo}>{ui()}</RepoProvider>);
}
