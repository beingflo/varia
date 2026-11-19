import { Show } from 'solid-js';
import { parsePath, usePath } from './lib/route';
import Notes from './views/Notes';
import NoteView from './views/NoteView';
import TodoView from './views/TodoView';

export default function App() {
  const path = usePath();
  return (
    <Show when={parsePath(path())} keyed>
      {(route) =>
        route.view === 'list' ? (
          <Notes />
        ) : route.view === 'note' ? (
          <NoteView id={route.id} />
        ) : (
          <TodoView id={route.id} />
        )
      }
    </Show>
  );
}
