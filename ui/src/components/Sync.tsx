import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { ago } from '../lib/time';
import { useSync } from '../sync/context';

/** Sync as one overlay: the state when enrolled, the enrolment code whenever the root is known. */
export default function Sync(props: { onClose: () => void }) {
  const sync = useSync();
  const [code, setCode] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [confirmUnlink, setConfirmUnlink] = createSignal(false);

  let field: HTMLInputElement | undefined;

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

  /** The input's action is always enrol; creating an account is the separate button below it. */
  const join = () => {
    if (code().trim()) void attempt(() => sync.enrol(code()));
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      // The enrolled view has nothing to type into, so Enter is the manual sync.
      if (e.key === 'Enter' && sync.enrolled() && !busy() && document.activeElement !== field) {
        void sync.run('manual');
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
    if (sync.enrolled()) void sync.run('manual');
    else field?.focus(); // the only thing to do here is paste a code
  });

  const codeBlock = () => (
    <>
      <p class="muted small">
        Your enrolment code. Anyone holding it can read every note and every future one, so keep it where you keep
        your passwords.
      </p>
      <p class="code">{sync.enrolment()}</p>
      <a
        class="small"
        download="varia-enrolment.txt"
        href={`data:text/plain,${encodeURIComponent(`${sync.enrolment()}\n`)}`}
      >
        download
      </a>
    </>
  );

  const enrolForm = () => (
    <>
      <p class="muted small">sync is off. Paste the enrolment code of another device:</p>
      <input
        ref={field}
        class="search"
        aria-label="enrolment code"
        autocomplete="off"
        spellcheck={false}
        value={code()}
        onInput={(e) => setCode(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') join();
        }}
      />
      <button type="button" class="action primary" disabled={busy() || !code().trim()} onClick={join}>
        join this device
      </button>
      <p class="separator muted small">or start from scratch</p>
      <button
        type="button"
        class="action"
        disabled={busy()}
        onClick={() => void attempt(() => sync.signup())}
      >
        create a new account
      </button>
    </>
  );

  const enrolledView = () => (
    <>
      <p class="muted small">{summary()}</p>
      <Show when={usage()}>
        <p class="muted small">{usage()}</p>
      </Show>
      <p class="muted small">press Enter to sync now, Escape to close</p>
      {codeBlock()}
      <p class="separator muted small">stop syncing this device; every note stays where it is</p>
      <button
        type="button"
        class="action"
        disabled={busy()}
        onClick={() => {
          if (!confirmUnlink()) {
            setConfirmUnlink(true); // two steps: unlinking loses the only copy of the root
            return;
          }
          void attempt(() => sync.unlink());
        }}
      >
        {confirmUnlink() ? 'click again to unlink' : 'unlink this device'}
      </button>
    </>
  );

  return (
    <section class="overlay" aria-label="sync">
      <Show when={sync.enrolled()} fallback={enrolForm()}>
        {enrolledView()}
      </Show>
      <Show when={error()}>
        <p class="small">{error()}</p>
      </Show>
    </section>
  );
}
