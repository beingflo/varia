import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { ago } from '../lib/time';
import { useSync } from '../sync/context';

type Fresh = { token: string; key: string };

/** Sync as one overlay: the state when enrolled, the two secrets separated, the key only once. */
export default function Sync(props: { onClose: () => void }) {
  const sync = useSync();
  const [token, setToken] = createSignal('');
  const [key, setKey] = createSignal('');
  const [fresh, setFresh] = createSignal<Fresh>();
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

  const ready = () => token().trim().length > 0 && key().trim().length > 0;

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

  const join = () => {
    if (ready()) void attempt(() => sync.enrol(token(), key()));
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      // The enrolled view has nothing to type into, so Enter is the manual sync.
      if (e.key === 'Enter' && sync.enrolled() && !fresh() && !busy() && document.activeElement !== field) {
        void sync.run('manual');
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
    if (sync.enrolled()) void sync.run('manual');
    else field?.focus(); // the only thing to do here is paste the two secrets
  });

  const secret = (label: string, value: string) => (
    <>
      <p class="muted small">{label}</p>
      <p class="code">{value}</p>
    </>
  );

  /** Shown once, right after signup: the key is not stored anywhere afterwards. */
  const freshView = (created: Fresh) => (
    <>
      <p class="small">
        Account created. These two strings are the only way back in, and this page is the only place the key will
        ever be shown.
      </p>
      {secret('1. Token — identifies the account on the server. Keep it, it is not secret on its own.', created.token)}
      {secret('2. Key — decrypts every note, forever. Nobody can recover it for you.', created.key)}
      <p class="small">
        Copy the key somewhere safe now, for example a password manager or the download below. Losing it loses every
        note on the server, and there is no reset.
      </p>
      <a
        class="small"
        download="varia-account.txt"
        href={`data:text/plain,${encodeURIComponent(`token: ${created.token}\nkey: ${created.key}\n`)}`}
      >
        download both
      </a>
      <p class="separator muted small">both strings are needed to sync another device</p>
      <button type="button" class="action primary" onClick={() => setFresh(undefined)}>
        I have saved the key
      </button>
    </>
  );

  const enrolForm = () => (
    <>
      <p class="muted small">sync is off. Paste the token and the key of an existing account:</p>
      <input
        ref={field}
        class="search"
        aria-label="account token"
        autocomplete="off"
        spellcheck={false}
        placeholder="token"
        value={token()}
        onInput={(e) => setToken(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') join();
        }}
      />
      <input
        class="search"
        aria-label="account key"
        autocomplete="off"
        spellcheck={false}
        placeholder="key"
        value={key()}
        onInput={(e) => setKey(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') join();
        }}
      />
      <button type="button" class="action primary" disabled={busy() || !ready()} onClick={join}>
        join this device
      </button>
      <p class="separator muted small">or start from scratch</p>
      <button
        type="button"
        class="action"
        disabled={busy()}
        onClick={() =>
          void attempt(async () => {
            const created = await sync.signup();
            setFresh(created);
          })
        }
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
      {secret('Token — this account on the server. The key that decrypts it is not stored here.', sync.token())}
      <p class="separator muted small">stop syncing this device; every note stays where it is</p>
      <button
        type="button"
        class="action"
        disabled={busy()}
        onClick={() => {
          if (!confirmUnlink()) {
            setConfirmUnlink(true); // two steps: nothing can be re-linked without the key
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
      <Show when={fresh()} keyed fallback={<Show when={sync.enrolled()} fallback={enrolForm()}>{enrolledView()}</Show>}>
        {(created) => freshView(created)}
      </Show>
      <Show when={error()}>
        <p class="small">{error()}</p>
      </Show>
    </section>
  );
}
