import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { OperationError } from '../ops/contract.ts';
import { protectedRegions } from '../fence-scan.ts';

const TAKES_PAIR=[{begin:TAKES_FENCE_BEGIN,end:TAKES_FENCE_END}];

/** The takes fence remote reads hid from this body (the same regions stripTakesFence removes). */
function fence(body:string):{text:string,read:boolean}|null {
  const {regions,truncatedAt}=protectedRegions(body,TAKES_PAIR);
  if(regions.length===0 && truncatedAt===-1) return null;
  if(truncatedAt!==-1 || regions.length>1) {
    throw new OperationError('invalid_params','The takes fence must be repaired before replacing this page.');
  }
  const region=regions[0]!;
  return {text:body.slice(region.start,region.end),read:region.read};
}
/** Remote full-page reads omit takes; a round trip must preserve their canonical fence. */
export function preserveProtectedTakes(incoming:string,stored:string):string {
  const before=fence(stored),after=fence(incoming);
  if(after!==null && after.text!==before?.text) throw new OperationError('permission_denied','Use the scoped takes operations to mutate a takes fence.');
  if(before===null || after!==null) return incoming;
  // A fence quoted in a code block was hidden from the remote reader, but
  // re-appending it at EOF would move it out of the block and make it live.
  if(!before.read) throw new OperationError('invalid_params','This page quotes a takes fence inside a code block, which remote reads hide; replace it with a local write.');
  return `${incoming.trimEnd()}\n\n${before.text}\n`;
}
