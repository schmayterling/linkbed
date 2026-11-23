// The published picker.d.ts omits the `database` member and the always-present shadow root
// that picker.js defines (node_modules/emoji-picker-element/picker.js:1706, 1801).
// deep paths need the .js extension: the package has no exports map.
import Base from 'emoji-picker-element/picker.js';
import type Database from 'emoji-picker-element/database.js';

export default class Picker extends Base {
  readonly database: Database;
  readonly shadowRoot: ShadowRoot;
}
