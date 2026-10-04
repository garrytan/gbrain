declare function opError(...args: unknown[]): Error;
export const op = { name: 'put_x', mutating: true, handler: async () => { throw opError('invalid_params', 'Failed.', 'Retry the call.'); } };
