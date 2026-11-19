import { createContext, useContext, type JSX } from 'solid-js';
import type { Repo } from './api';

const RepoContext = createContext<Repo>();

export function RepoProvider(props: { repo: Repo; children: JSX.Element }) {
  return <RepoContext.Provider value={props.repo}>{props.children}</RepoContext.Provider>;
}

export function useRepo(): Repo {
  const repo = useContext(RepoContext);
  if (!repo) throw new Error('useRepo outside RepoProvider');
  return repo;
}
