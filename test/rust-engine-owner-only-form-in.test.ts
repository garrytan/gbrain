/**
 * The Rust store learns which owner-only test a rendered read policy carries from `ownerOnlyFormIn`. Master's v328
 * renders the 'mode' form (the function call with the login's read mode); the store must read it as the function
 * form, never as 'off', or a caller who is not the owner sees owner-only rows on the Rust engine.
 */
import { describe, expect, test } from 'bun:test';
import { ownerOnlyFactSql, ownerOnlyPageSql } from '../src/core/access/owner-only.ts';
import { ownerOnlyFormIn } from '../src/core/rust-engine/store-members/private-provenance.ts';

describe('ownerOnlyFormIn reads every owner-only form the schema can render', () => {
  for (const table of ['pages', 'facts'] as const) {
    const render = (form: 'mode' | 'fn' | 'closed') => (table === 'pages' ? ownerOnlyPageSql('p', form) : ownerOnlyFactSql('p', form));
    test(`${table}: the v328 mode form reads as the function form, not off`, () => {
      expect(ownerOnlyFormIn(`SELECT 1 WHERE NOT ${render('mode')}`, table, 'p')).toBe('fn');
    });
    test(`${table}: the function form reads as the function form`, () => {
      expect(ownerOnlyFormIn(`SELECT 1 WHERE NOT ${render('fn')}`, table, 'p')).toBe('fn');
    });
    test(`${table}: the closed form reads as closed`, () => {
      expect(ownerOnlyFormIn(`SELECT 1 WHERE NOT ${render('closed')}`, table, 'p')).toBe('closed');
    });
    test(`${table}: a text with no owner-only test reads as off`, () => {
      expect(ownerOnlyFormIn('SELECT 1 WHERE true', table, 'p')).toBe('off');
    });
  }
});
