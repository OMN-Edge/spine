import { describe, expect, it } from 'vitest';
import { WELCOME_NOTES, welcomeMode } from './guide';

describe('welcomeMode: the welcome is offered, never put over the page', () => {
  it('the first time is a note beside Ask, not the chat opened by itself', () => {
    expect(welcomeMode({ shown: 0, done: false, uploads: 0 })).toBe('note');
  });

  it('is offered a few times, then not again', () => {
    expect(welcomeMode({ shown: WELCOME_NOTES, done: false, uploads: 0 })).toBe('note');
    expect(welcomeMode({ shown: WELCOME_NOTES + 1, done: false, uploads: 0 })).toBe('none');
  });

  it('ends once something was done from it, or a first upload', () => {
    expect(welcomeMode({ shown: 1, done: true, uploads: 0 })).toBe('none');
    expect(welcomeMode({ shown: 1, done: false, uploads: 1 })).toBe('none');
  });
});
