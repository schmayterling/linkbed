export { default } from 'codemirror';

// options added by the matchbrackets and closebrackets addons bundled by scripts/vendor.ts
declare module 'codemirror' {
  interface EditorConfiguration {
    matchBrackets?: boolean;
    autoCloseBrackets?: boolean;
  }
}
