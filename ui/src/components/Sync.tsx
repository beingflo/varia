import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { ago } from '../lib/time';
import { useSync } from '../sync/context';

/** Sync as one overlay: the state when enrolled, the enrolment code the one time it can be shown. */
export default function Sync(props: { onClose: () => void }) {
  const sync = useSync();
  const [code, setCode] = createSignal('');
  const [fresh, setFresh] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const summary = createMemo(() => {
    const s = sync.status();
    if (s.state === 'syncing') return 'syncing…';
    if (s.state === 'error') return `sync failed — ${s.error}`;
    if (!s.last) return 'not synced yet';
    return `synced ${ago(s.last)} · ${s.pending === 0 ? 'nothing pending' : `${s.pending} pending`}`;
  });

  const usage = createMemo(() => {
    const s = sync.status();
    if (!s.cap) return '';
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1);
    return `${mb(s.usage)} of ${mb(s.cap)} MB used`;
  });

  const attempt = async (action: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Nothing here creates an account by accident: a stray Enter must not sign you up. */
  const onFormKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    if (code().trim()) void attempt(() => sync.enrol(code())); // a pasted code always wins
    else if (e.metaKey || e.ctrlKey) void attempt(async () => setFresh(await sync.signup()));
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      // The enrolled view has nothing to type into, so Enter is the manual sync.
      if (e.key === 'Enter' && sync.enrolled() && !fresh() && !busy()) void sync.run('manual');
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
    if (sync.enrolled()) void sync.run('manual');
    else field?.focus(); // the only thing to do here is paste a code
  });

  let field: HTMLInputElement | undefined;

  const enrolForm = () => (
    <>
      <p class="muted small">
        sync is off. Paste the enrolment code of another device and press Enter. With no code yet, press ⌘Enter to
        create an account — you will get the code to write down.
      </p>
      <input
        ref={field}
        class="search"
        aria-label="enrolment code"
        autocomplete="off"
        spellcheck={false}
        value={code()}
        onInput={(e) => setCode(e.currentTarget.value)}
        onKeyDown={onFormKey}
      />
    </>
  );

  const enrolledView = () => (
    <>
      <p class="muted small">{summary()}</p>
      <Show when={usage()}>
        <p class="muted small">{usage()}</p>
      </Show>
      <p class="muted small">press Enter to sync now, Escape to close</p>
    </>
  );

  return (
    <section class="overlay" aria-label="sync">
      <Show when={fresh()} fallback={<Show when={sync.enrolled()} fallback={enrolForm()}>{enrolledView()}</Show>}>
        <p class="small">
          This is your enrolment code, and the only copy: write it down or download it. It is what a second device
          needs to read your notes.
        </p>
        <p class="code">{fresh()}</p>
        <a class="small" download="varia-enrolment.txt" href={`data:text/plain,${encodeURIComponent(`${fresh()}\n`)}`}>
          download
        </a>
      </Show>
      <Show when={error()}>
        <p class="small">{error()}</p>
      </Show>
    </section>
  );
}
