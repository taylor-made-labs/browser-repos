import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

describe('browser-repos seed', () => {
  it('exposes a semantic version string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
