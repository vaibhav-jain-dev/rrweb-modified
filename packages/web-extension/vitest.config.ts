/// <reference types="vitest" />
import { defineProject, mergeConfig } from 'vitest/config';
import { resolve } from 'node:path';
import configShared from '../../vitest.config.ts';

export default mergeConfig(
  configShared,
  defineProject({
    resolve: {
      alias: {
        '~': resolve(__dirname, 'src'),
      },
    },
    test: {
      globals: true,
      environment: 'happy-dom',
      include: ['test/**/*.test.ts'],
    },
  }),
);
