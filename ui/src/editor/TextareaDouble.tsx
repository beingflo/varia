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
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
          props.onReady?.({ focusEnd: () => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
        })
      }
      onInput={(e) => props.onInput(e.currentTarget.value)}
      onBlur={() => props.onBlur?.()}
    />
  );
}
