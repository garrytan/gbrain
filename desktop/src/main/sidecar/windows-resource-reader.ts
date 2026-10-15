import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const script=String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PMBrainResourceReader {
  [StructLayout(LayoutKind.Sequential)]
  public struct Performance {
    public uint Size;
    public UIntPtr CommitTotal,CommitLimit,CommitPeak,PhysicalTotal,PhysicalAvailable,SystemCache,KernelTotal,KernelPaged,KernelNonpaged,PageSize;
    public uint HandleCount,ProcessCount,ThreadCount;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  public struct ProcessEntry {
    public uint Size,Usage,Id;
    public UIntPtr Heap;
    public uint Module,Threads,Parent;
    public int Priority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
  }
  public class Sample {
    public long bytes,availableBytes,commitLimitBytes,committedBytes;
    public string startedAt;
  }
  [DllImport("psapi.dll",SetLastError=true)] static extern bool GetPerformanceInfo(out Performance value,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint id);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref ProcessEntry value);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref ProcessEntry value);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static Sample Read(int id) {
    Process root;
    try { root=Process.GetProcessById(id); } catch(ArgumentException) { return null; }
    using(root) {
      DateTime born;
      try { born=root.StartTime.ToUniversalTime(); } catch(InvalidOperationException) { return null; }
      var rows=new List<ProcessEntry>();
      var snapshot=CreateToolhelp32Snapshot(2,0);
      if(snapshot==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        var row=new ProcessEntry();row.Size=(uint)Marshal.SizeOf(typeof(ProcessEntry));
        if(!Process32FirstW(snapshot,ref row))throw new Win32Exception(Marshal.GetLastWin32Error());
        do { rows.Add(row); } while(Process32NextW(snapshot,ref row));
      } finally { CloseHandle(snapshot); }
      var owned=new Dictionary<int,DateTime>();owned[id]=born;
      long bytes=root.PrivateMemorySize64;
      bool added;
      do {
        added=false;
        foreach(var row in rows) {
          int childId=(int)row.Id;
          DateTime parentBorn;
          if(owned.ContainsKey(childId)||!owned.TryGetValue((int)row.Parent,out parentBorn))continue;
          try {
            using(var child=Process.GetProcessById(childId)) {
              var childBorn=child.StartTime.ToUniversalTime();
              if(childBorn<parentBorn)continue;
              owned.Add(childId,childBorn);bytes+=child.PrivateMemorySize64;added=true;
            }
          } catch(ArgumentException) { }
            catch(InvalidOperationException) { }
          if(owned.Count>128)throw new InvalidOperationException("Controlled process tree exceeds resource limit");
        }
      } while(added);
      if(root.HasExited)return null;
      Performance memory;
      if(!GetPerformanceInfo(out memory,(uint)Marshal.SizeOf(typeof(Performance))))throw new Win32Exception(Marshal.GetLastWin32Error());
      long page=(long)memory.PageSize.ToUInt64();
      return new Sample {bytes=bytes,availableBytes=(long)memory.PhysicalAvailable.ToUInt64()*page,
        commitLimitBytes=(long)memory.CommitLimit.ToUInt64()*page,committedBytes=(long)memory.CommitTotal.ToUInt64()*page,
        startedAt=born.ToString("o")};
    }
  }
}
'@
while($null -ne ($request=[Console]::ReadLine())) {
  try {
    $value=[PMBrainResourceReader]::Read([int]$request)
    @{ok=$true;value=$value}|ConvertTo-Json -Depth 3 -Compress
  } catch { @{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress }
}
`;

class WindowsResourceReader {
  private child:ChildProcessWithoutNullStreams|null=null;
  private pending?:{resolve:(value:string)=>void;reject:(error:Error)=>void};
  private tail:Promise<unknown>=Promise.resolve();
  private first=true;
  private stderr='';
  private closed=false;
  read(pid:number):Promise<string>{
    const result=this.tail.then(()=>this.request(pid));
    this.tail=result.catch(()=>{});
    return result;
  }
  private request(pid:number):Promise<string>{
    if(this.closed)throw new Error('Windows 资源采样已关闭');
    if(!this.child){
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:'pipe'});
      this.child=child;this.first=true;this.stderr='';
      const lines=createInterface({input:child.stdout});
      lines.on('line',line=>{
        if(this.child!==child)return;
        const pending=this.pending;if(!pending)return;
        try{
          const response=JSON.parse(line) as {ok:boolean;value:unknown;error?:string};
          if(!response.ok)throw new Error(`Windows 资源采样失败：${response.error}`);
          pending.resolve(response.value==null?'':JSON.stringify(response.value));
        }catch(error){this.fail(error instanceof Error?error:new Error(String(error)));}
      });
      child.stderr.on('data',data=>{this.stderr=(this.stderr+String(data)).slice(-4096);});
      child.on('error',error=>{if(this.child===child)this.fail(error);});
      child.on('exit',(code,signal)=>{if(this.child===child)this.fail(new Error(`Windows 资源采样进程退出：${code??signal} ${this.stderr}`));lines.close();});
    }
    return new Promise<string>((resolve,reject)=>{
      const timeout=setTimeout(()=>this.fail(new Error('Windows 资源采样超时')),this.first?10000:4000);
      this.first=false;
      const finish=(callback:()=>void)=>{clearTimeout(timeout);this.pending=undefined;callback();};
      this.pending={resolve:value=>finish(()=>resolve(value)),reject:error=>finish(()=>reject(error))};
      const child=this.child!;
      child.stdin.write(`${pid}\n`,error=>{if(error&&this.child===child)this.fail(error);});
    });
  }
  private fail(error:Error){const child=this.child;this.child=null;this.pending?.reject(error);child?.kill();}
  close(){this.closed=true;this.fail(new Error('Windows 资源采样已关闭'));}
}

let reader:WindowsResourceReader|undefined;
export function readWindowsResourceSample(pid:number):Promise<string>{return (reader??=new WindowsResourceReader()).read(pid);}
export function closeWindowsResourceReader(){reader?.close();reader=undefined;}
