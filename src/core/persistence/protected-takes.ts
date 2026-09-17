import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { OperationError } from '../ops/contract.ts';

function fence(body:string):string|null {
  const start=body.indexOf(TAKES_FENCE_BEGIN);
  if(start<0) return null;
  const end=body.indexOf(TAKES_FENCE_END,start+TAKES_FENCE_BEGIN.length);
  if(end<0 || body.indexOf(TAKES_FENCE_BEGIN,start+TAKES_FENCE_BEGIN.length)>=0) {
    throw new OperationError('invalid_params','The takes fence must be repaired before replacing this page.');
  }
  return body.slice(start,end+TAKES_FENCE_END.length);
}
/** Remote full-page reads omit takes; a round trip must preserve their canonical fence. */
export function preserveProtectedTakes(incoming:string,stored:string):string {
  const before=fence(stored),after=fence(incoming);
  if(after!==null && after!==before) throw new OperationError('permission_denied','Use the scoped takes operations to mutate a takes fence.');
  if(before===null || after!==null) return incoming;
  return `${incoming.trimEnd()}\n\n${before}\n`;
}
