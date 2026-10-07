import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { opError } from '../ops/contract.ts';
import { protectedRegions } from '../fence-scan.ts';

const TAKES_PAIR=[{begin:TAKES_FENCE_BEGIN,end:TAKES_FENCE_END}];

/** The takes fence remote reads hide in this body (the region stripTakesFence removes); read=false when readers see it as code. */
function fence(body:string):{text:string,read:boolean}|null {
  const {regions,truncatedAt}=protectedRegions(body,TAKES_PAIR);
  if(regions.length===0 && truncatedAt===-1) return null;
  if(truncatedAt!==-1 || regions.length>1) {
    throw opError('invalid_params','The takes fence must be repaired before replacing this page.',
      'The stored page has an unclosed or repeated takes fence, so a full replacement could lose takes. Ask the user to repair the fence (one begin and one end marker) in the page, then replace it again.');
  }
  const region=regions[0]!;
  return {text:body.slice(region.start,region.end),read:region.read};
}
/** Remote full-page reads omit takes; a round trip must preserve their canonical fence. */
export function preserveProtectedTakes(incoming:string,stored:string):string {
  const before=fence(stored),after=fence(incoming);
  if(after!==null && after.text!==before?.text) throw opError('permission_denied','Use the scoped takes operations to mutate a takes fence.',
    'Send the page without its takes fence (it is preserved automatically), and change takes with takes_add, takes_update, takes_supersede, or takes_resolve.');
  if(before===null || after!==null) return incoming;
  // A fence quoted in markdown code was hidden from the remote reader, but
  // re-appending it at EOF would move it out of the code and make it live.
  if(!before.read) throw opError('invalid_params','This page quotes a takes fence inside markdown code, so a remote replacement cannot preserve it.',
    'Ask the user to replace this page with a local write (gbrain put on the brain host), or send the page with only the prose you mean to change through a scoped edit.',
    { why: 'Remote reads hide the quoted fence; re-appending it at the end of the page would move it out of the code block and turn the example into a live takes fence.' });
  return `${incoming.trimEnd()}\n\n${before.text}\n`;
}
