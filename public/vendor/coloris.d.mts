import Coloris from '@melloware/coloris';

type Options = NonNullable<Parameters<typeof Coloris>[0]>;
type Accessibility = NonNullable<Options['a11y']>;

// Coloris merges individual labels into its defaults.
declare const coloris: typeof Coloris &
  ((options: Omit<Options, 'a11y'> & { a11y?: Partial<Accessibility> }) => void);

export default coloris;
