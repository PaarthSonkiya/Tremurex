import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('shared package harness', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('@tremurex/shared');
  });
});
