// The engine is created once in App and handed down; tests provide their own fake.
import { createContext, useContext } from 'solid-js';
import type { Engine } from './engine';

const SyncContext = createContext<Engine>();

export function SyncProvider(props: { engine: Engine; children?: unknown }) {
  return <SyncContext.Provider value={props.engine}>{props.children as never}</SyncContext.Provider>;
}

export function useSync(): Engine {
  const engine = useContext(SyncContext);
  if (!engine) throw new Error('useSync outside a SyncProvider');
  return engine;
}
