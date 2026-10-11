import {describe,expect,test} from 'bun:test';
import {dialogBackdropClick} from '../admin/src/lib/dialog-backdrop';

const dialog={getBoundingClientRect:()=>({left:800,right:1400,top:0,bottom:900})};
const event=(x:number,y:number,target:unknown=dialog)=>({target,currentTarget:dialog,clientX:x,clientY:y});

describe('侧边抽屉外侧点击',()=>{
  test('空白遮罩在抽屉四边以外时关闭',()=>{
    for(const [x,y] of [[200,400],[1500,400],[1000,-1],[1000,901]]){
      let closed=0;dialogBackdropClick(event(x,y),()=>closed++);expect(closed).toBe(1);
    }
  });
  test('内部空白、边缘和子控件点击不关闭',()=>{
    for(const input of [event(1000,400),event(800,0),event(1400,900),event(1000,400,{})]){
      let closed=0;dialogBackdropClick(input,()=>closed++);expect(closed).toBe(0);
    }
  });
});
