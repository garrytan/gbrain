import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { opError } from '../ops/contract.ts';

function fence(body:string):string|null {
  const start=body.indexOf(TAKES_FENCE_BEGIN);
  if(start<0) return null;
  const end=body.indexOf(TAKES_FENCE_END,start+TAKES_FENCE_BEGIN.length);
  if(end<0 || body.indexOf(TAKES_FENCE_BEGIN,start+TAKES_FENCE_BEGIN.length)>=0) {
    throw opError('invalid_params','The takes fence must be repaired before replacing this page.',
      'The stored page has an unclosed or repeated takes fence, so a full replacement could lose takes. Ask the user to repair the fence (one begin and one end marker) in the page, then replace it again.');
  }
  return body.slice(start,end+TAKES_FENCE_END.length);
}
/** Remote full-page reads omit takes; a round trip must preserve their canonical fence. */
export function preserveProtectedTakes(incoming:string,stored:string):string {
  const before=fence(stored),after=fence(incoming);
  if(after!==null && after!==before) throw opError('permission_denied','Use the scoped takes operations to mutate a takes fence.',
    'Send the page without its takes fence (it is preserved automatically), and change takes with takes_add, takes_update, takes_supersede, or takes_resolve.');
  if(before===null || after!==null) return incoming;
  return `${incoming.trimEnd()}\n\n${before}\n`;
}
