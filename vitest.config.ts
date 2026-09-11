import { defineConfig } from 'vitest/config';
import path from 'path';

const alias = { '@': path.resolve(__dirname, 'src') };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          setupFiles: [],
          include: ['src/**/*.test.ts'],
          exclude: ['node_modules', '.next', 'e2e'],
        },
      },
      {
        test: {
          name: 'dom',
          globals: true,
          environment: 'happy-dom',
          setupFiles: [],
          include: ['src/**/*.test.tsx'],
          exclude: ['node_modules', '.next', 'e2e'],
        },
      },
    ],
  },
});