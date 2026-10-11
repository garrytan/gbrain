export function dialogBackdropClick(event:{target:unknown;currentTarget:{getBoundingClientRect():{left:number;right:number;top:number;bottom:number}};clientX:number;clientY:number},onClose:()=>void):void{
  if(event.target!==event.currentTarget)return;
  const bounds=event.currentTarget.getBoundingClientRect();
  if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)onClose();
}
