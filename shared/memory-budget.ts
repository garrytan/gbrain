export interface MemorySample {
  bytes:number;
  availableBytes:number;
  totalBytes?:number;
  commitHeadroomBytes?:number;
}

export function memoryPressure(sample:MemorySample):{level:'normal'|'constrained'|'critical';budgetBytes:number;reason:string}{
  const gib=1024**3;
  const total=sample.totalBytes??8*gib;
  const budgetBytes=Math.max(2*gib,Math.min(8*gib,total/4));
  const reserve=Math.max(gib,Math.min(2*gib,total/8));
  const available=Math.min(sample.availableBytes,sample.commitHeadroomBytes??Infinity);
  if(available<256*1024**2){
    const physicalLow=sample.availableBytes<256*1024**2;
    const commitLow=(sample.commitHeadroomBytes??Infinity)<256*1024**2;
    const cause=physicalLow&&commitLow?'系统可用物理内存和提交余量均不足 256MB':physicalLow?'系统可用物理内存不足 256MB':'系统提交余量不足 256MB';
    const readings=`可用物理内存 ${Math.floor(sample.availableBytes/1024**2)} MB${sample.commitHeadroomBytes===undefined?'':`，提交余量 ${Math.floor(sample.commitHeadroomBytes/1024**2)} MB`}`;
    const advice=commitLow?'请关闭占用较大的程序，并检查 Windows 虚拟内存（分页文件）设置':'请关闭占用较大的程序以释放内存';
    return {level:'critical',budgetBytes,reason:`${cause}（${readings}；${advice}）`};
  }
  if(available<reserve)return {level:'constrained',budgetBytes,reason:'系统内存余量较低，正在降低后台处理量'};
  if(sample.bytes>=budgetBytes)return {level:'constrained',budgetBytes,reason:`后台工作集达到 ${Math.ceil(sample.bytes/1024**2)} MB，正在回收闲置资源并降低并发`};
  return {level:'normal',budgetBytes,reason:''};
}
