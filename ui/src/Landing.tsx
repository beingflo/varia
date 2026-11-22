import { For, Show } from 'solid-js';
import { BINDINGS, chordLabel } from './lib/commands';
import { hasEntered, markEntered } from './lib/entry';
import './landing.css';

export default function Landing() {
  const use = () => {
    markEntered();
    // A device that refuses the flag would bounce back to the landing from `/`, so go to `/app`.
    location.assign(hasEntered() ? '/' : '/app');
  };

  return (
    <div class="landing">
      <header>
        <div class="wrap">
          <div class="brand">
            <img src="/favicon.svg" alt="" width="32" height="32" />
            <h1>varia</h1>
          </div>
          <p class="tagline">notes and lists that live on your own device.</p>
          <button class="cta" onClick={use}>
            use now
          </button>
        </div>
      </header>

      <section class="band sand">
        <div class="wrap">
          <h2>notes, lists, and what they become</h2>
          <dl>
            <div>
              <dt>markdown notes</dt>
              <dd>plain text, written in place, tagged.</dd>
            </div>
            <div>
              <dt>lists</dt>
              <dd>a note can be a list; check items off, hide what is done.</dd>
            </div>
            <div>
              <dt>versions</dt>
              <dd>every save keeps its history, and any version can be restored.</dd>
            </div>
            <div>
              <dt>search</dt>
              <dd>one box across note bodies and list items.</dd>
            </div>
            <div>
              <dt>a url per note</dt>
              <dd>bookmark a note, reload it, land in the same place.</dd>
            </div>
            <div>
              <dt>many tabs</dt>
              <dd>every tab shares one database, and sees the others' writes.</dd>
            </div>
          </dl>
        </div>
      </section>

      <section class="band sage">
        <div class="wrap">
          <h2>nothing leaves the device</h2>
          <dl>
            <div>
              <dt>local first</dt>
              <dd>stored in this browser, in a database only you hold the key to.</dd>
            </div>
            <div>
              <dt>no account</dt>
              <dd>nothing to sign up for; it works before there is a server.</dd>
            </div>
            <div>
              <dt>offline</dt>
              <dd>works without a connection, installs to the home screen.</dd>
            </div>
            <div>
              <dt>sync, if you want it</dt>
              <dd>optional, end-to-end encrypted, never required.</dd>
            </div>
          </dl>
        </div>
      </section>

      <section class="shortcuts">
        <div class="wrap">
          <h2>shortcuts</h2>
          <dl class="keys">
            <For each={BINDINGS.filter((binding) => !binding.hidden)}>
              {(binding) => (
                <>
                  <dt>
                    <For each={binding.chords}>
                      {(chord, index) => (
                        <>
                          <kbd>{chordLabel(chord)}</kbd>
                          <Show when={index() < binding.chords.length - 1}>
                            <kbd class="or">or</kbd>
                          </Show>
                        </>
                      )}
                    </For>
                  </dt>
                  <dd>{binding.label}</dd>
                </>
              )}
            </For>
          </dl>
          <p class="hint">
            browsers reserve some plain chords, so every command also answers to an ⌥⌘ form. on windows and linux, ⌘
            is ctrl.
          </p>
        </div>
      </section>
    </div>
  );
}
