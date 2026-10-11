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
  if(available<256*1024**2)return {level:'critical',budgetBytes,reason:'系统可用内存或提交余量不足 256MB'};
  if(available<reserve)return {level:'constrained',budgetBytes,reason:'系统内存余量较低，正在降低后台处理量'};
  if(sample.bytes>=budgetBytes)return {level:'constrained',budgetBytes,reason:`后台工作集达到 ${Math.ceil(sample.bytes/1024**2)} MB，正在回收闲置资源并降低并发`};
  return {level:'normal',budgetBytes,reason:''};
}
