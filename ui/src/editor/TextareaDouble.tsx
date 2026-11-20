// Test double for the CodeMirror editor: same props, plain textarea, works in jsdom.
import type { EditorProps } from './Editor';

export default function TextareaDouble(props: EditorProps) {
  return (
    <textarea
      class="editor"
      aria-label={props.ariaLabel}
      placeholder={props.placeholder}
      value={props.value}
      ref={(el) =>
        queueMicrotask(() => {
          props.onReady?.({
            focusEnd: () => {
              el.focus();
              el.setSelectionRange(el.value.length, el.value.length);
            },
          });
          // A dashboard tile must not take the caret, exactly like the real editor.
          if (props.autoFocus === false) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        })
      }
      onInput={(e) => props.onInput(e.currentTarget.value)}
      onBlur={() => props.onBlur?.()}
    />
  );
}
