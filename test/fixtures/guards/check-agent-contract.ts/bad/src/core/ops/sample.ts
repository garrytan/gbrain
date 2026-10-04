declare function opError(...args: unknown[]): Error;
export function f() { throw opError('not_registered_anywhere', 'Bad.', 'Fix it.'); }
