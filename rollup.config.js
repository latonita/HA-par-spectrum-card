import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

export default {
  input: 'as734x-spectrum-card.js',
  output: {
    file: 'dist/as734x-spectrum-card.js',
    format: 'es',
  },
  plugins: [resolve(), terser()],
};
