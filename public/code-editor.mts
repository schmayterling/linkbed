import CodeMirror from './vendor/codemirror.mjs';

export interface JsonEditor {
  set(value: string): void;
  focus(): void;
  format(): void;
}

export function createJsonEditor(textarea: HTMLTextAreaElement, onChange: () => void): JsonEditor {
  const editor = CodeMirror.fromTextArea(textarea, {
    mode: { name: 'javascript', json: true },
    theme: 'linkbed',
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    tabSize: 2,
    matchBrackets: true,
    autoCloseBrackets: true,
    screenReaderLabel: 'card json editor',
    extraKeys: { Esc: false },
  });
  editor.on('change', (_editor, change) => {
    editor.save();
    if (change.origin !== 'setValue') onChange();
  });
  return {
    set(value: string) {
      if (value !== editor.getValue()) editor.setValue(value);
    },
    focus() {
      editor.refresh();
      editor.focus();
    },
    format() {
      editor.replaceRange(
        JSON.stringify(JSON.parse(editor.getValue()), null, 2),
        { line: 0, ch: 0 },
        { line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length },
      );
    },
  };
}
