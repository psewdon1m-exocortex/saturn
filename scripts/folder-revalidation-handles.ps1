param([Parameter(Mandatory=$true)][string]$PlanFile)
$ErrorActionPreference='Stop'
[Diagnostics.Process]::GetCurrentProcess().PriorityClass='BelowNormal'
[Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity=15
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
# Private offline helper. No SQL, mutation, journal manipulation or elevation.
# The parent owns a private stdin/stdout channel; EOF and a hard lifetime close
# every handle. It never follows a reparse point or falls back to path-only stat.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public sealed class FolderRevalidationHandles : IDisposable {
 public static System.Threading.Timer Deadline(){return new System.Threading.Timer(delegate(object state){Environment.Exit(74);},null,90000,System.Threading.Timeout.Infinite);}
 [StructLayout(LayoutKind.Sequential)] struct Info {
  public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;
  public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeFileHandle h,out long creation,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(SafeFileHandle h,uint ms);
 public static void AssertDrained(uint pid,string expectedCreation){
  using(var h=OpenProcess(0x101000,false,pid)){
   if(h.IsInvalid){int error=Marshal.GetLastWin32Error();if(error==87)return;throw new Win32Exception(error);}
   long creation,exit,kernel,user;if(!GetProcessTimes(h,out creation,out exit,out kernel,out user))throw new Win32Exception(Marshal.GetLastWin32Error());
   if(creation.ToString()==expectedCreation&&WaitForSingleObject(h,0)==258)throw new IOException("Original writer is still alive");
  }
 }
 sealed class Pin {public string Path;public SafeFileHandle Handle;public FileStream Stream;public Info Before;public bool Directory;}
 readonly Dictionary<string,Pin> pins=new Dictionary<string,Pin>(StringComparer.OrdinalIgnoreCase);
 readonly List<Pin> order=new List<Pin>();
 System.Threading.Mutex custody;
 public void Own(string identity){
  custody=new System.Threading.Mutex(false,"Global\\SaturnFolderRevalidation_"+identity.Replace(":","_"));
  try{if(!custody.WaitOne(0)){custody.Dispose();custody=null;throw new IOException("Another operator holds backend custody");}}
  catch(System.Threading.AbandonedMutexException){custody.ReleaseMutex();custody.Dispose();custody=null;throw new IOException("Abandoned backend custody requires reconciliation");}
 }
 static Info Read(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))throw new Win32Exception(Marshal.GetLastWin32Error());return i;}
 static string Identity(Info i){return i.Volume.ToString("x8")+":"+i.IndexHigh.ToString("x8")+i.IndexLow.ToString("x8");}
 static ulong Size(Info i){return ((ulong)i.SizeHigh<<32)|i.SizeLow;}
 static SafeFileHandle Open(string p){var h=CreateFile(p,0x80000000,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(h.IsInvalid){h.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}return h;}
 public string Add(string path,bool directory,string size,string sha){
  path=System.IO.Path.GetFullPath(path);Pin known;
  if(pins.TryGetValue(path,out known)){if(known.Directory!=directory)throw new IOException("Path kind conflict");return Identity(known.Before);}
  var handle=Open(path);FileStream stream=null;
  try{
   var before=Read(handle);if((before.Attributes&1024)!=0||((before.Attributes&16)!=0)!=directory||GetFileType(handle)!=1)throw new IOException("Reparse or unsupported object");
   if(!directory){
    if(before.Links!=1||Size(before).ToString()!=size)throw new IOException("Physical size or link mismatch");
    stream=new FileStream(handle,FileAccess.Read,65536,false);
    using(var hash=SHA256.Create()){if(BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant()!=sha)throw new IOException("Physical SHA mismatch");}
    if(Identity(Read(handle))!=Identity(before))throw new IOException("Physical identity changed");
   }
   var pin=new Pin{Path=path,Handle=handle,Stream=stream,Before=before,Directory=directory};pins.Add(path,pin);order.Add(pin);return Identity(before);
  }catch{if(stream!=null)stream.Dispose();handle.Dispose();throw;}
 }
 public void Check(){
  foreach(var pin in order){
   var current=Read(pin.Handle);
   if(Identity(current)!=Identity(pin.Before)||(current.Attributes&1024)!=0||((current.Attributes&16)!=0)!=pin.Directory)throw new IOException("Held identity changed");
   if(!pin.Directory&&(Size(current)!=Size(pin.Before)||current.Write.dwHighDateTime!=pin.Before.Write.dwHighDateTime||current.Write.dwLowDateTime!=pin.Before.Write.dwLowDateTime||current.Links!=1))throw new IOException("Held file changed");
   using(var reopened=Open(pin.Path)){if(Identity(Read(reopened))!=Identity(pin.Before))throw new IOException("Path identity changed");}
  }
 }
 public void Dispose(){for(int n=order.Count-1;n>=0;n--){if(order[n].Stream!=null)order[n].Stream.Dispose();order[n].Handle.Dispose();}order.Clear();pins.Clear();if(custody!=null){custody.ReleaseMutex();custody.Dispose();custody=null;}}
}
'@
$deadline=[FolderRevalidationHandles]::Deadline()
$held=New-Object FolderRevalidationHandles
try {
 if((Get-Item -LiteralPath $PlanFile).Length -gt 4259840){throw 'Plan exceeds bound'}
 $plan=[IO.File]::ReadAllText($PlanFile)|ConvertFrom-Json
 if($plan.schema -cne 'saturn.folder-revalidation-native-plan.v1'){throw 'Plan schema'}
 $backend=[IO.Path]::GetFullPath([string]$plan.backendRoot).TrimEnd('\')
 if($backend -notmatch '^[A-Za-z]:\\' -or $backend.Length -lt 4){throw 'Local backend root required'}
 $ancestors=New-Object 'System.Collections.Generic.List[string]'
 $current=New-Object IO.DirectoryInfo($backend)
 while($current){$ancestors.Add($current.FullName);$current=$current.Parent}
 $backendId=$null
 for($n=$ancestors.Count-1;$n -ge 0;$n--){$id=$held.Add($ancestors[$n],$true,'0','');if($n -eq 0){$backendId=$id}}
 $held.Own($backendId)
 $tree=@($plan.intent.tree)
 if($tree.Count -lt 1 -or $tree.Count -gt 1024){throw 'Tree bound'}
 $paths=@{};$total=[Int64]0;$files=0;$folders=0
 foreach($entry in $tree){
  $relative=[string]$entry.storagePath
  if($relative -match '(^/|/$|//|\\|[\x00-\x1f]|(^|/)\.\.?(/|$))'){throw 'Unsafe storage path'}
  $target=[IO.Path]::GetFullPath([IO.Path]::Combine($backend,$relative.Replace('/','\')))
  if(-not $target.StartsWith($backend+'\',[StringComparison]::OrdinalIgnoreCase) -or $paths.ContainsKey($target)){throw 'Path escape or duplicate'}
  $paths[$target]=$entry
  if($entry.description.type -ceq 'file'){$total += [Int64]$entry.description.size_bytes;$files++}elseif($entry.description.type -ceq 'folder'){$folders++}else{throw 'Unsupported type'}
 }
 if($total -lt 0 -or $total -gt 134217728){throw 'Physical verification byte budget'}
 # Pin path ancestors omitted from the scoped catalogue as well (e.g. CONTROL).
 foreach($target in @($paths.Keys|Sort-Object Length)){
  $entry=$paths[$target];$parent=[IO.Directory]::GetParent($target)
  $stack=New-Object 'System.Collections.Generic.List[string]'
  while($parent -and $parent.FullName.Length -gt $backend.Length){$stack.Add($parent.FullName);$parent=$parent.Parent}
  for($n=$stack.Count-1;$n -ge 0;$n--){$null=$held.Add($stack[$n],$true,'0','')}
  $null=$held.Add($target,($entry.description.type -ceq 'folder'),[string]$entry.description.size_bytes,[string]$entry.description.content_sha256)
 }
 function Assert-Tree {
  if($plan.drainedProcesses){
   if(@($plan.drainedProcesses).Count -gt 32){throw 'Writer bound'}
   foreach($writer in $plan.drainedProcesses){
    if([Int64]$writer.pid -lt 1 -or [Int64]$writer.pid -gt 4294967295 -or [string]$writer.creationFileTime -notmatch '^[1-9][0-9]{1,19}$'){throw 'Writer identity'}
    [FolderRevalidationHandles]::AssertDrained([UInt32]$writer.pid,[string]$writer.creationFileTime)
   }
  }
  $held.Check()
  foreach($target in $paths.Keys){
   $entry=$paths[$target]
   if($entry.description.type -cne 'folder'){continue}
   $actual=@([IO.Directory]::EnumerateFileSystemEntries($target)|ForEach-Object{[IO.Path]::GetFileName($_)})
   $expected=@($tree|Where-Object{$_.description.parent_id -ceq $entry.description.node_id}|ForEach-Object{[string]$_.description.name})
   if($actual.Count -ne $expected.Count){throw 'Physical membership differs'}
   $set=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
   foreach($name in $expected){if(-not $set.Add($name)){throw 'Duplicate name'}}
   foreach($name in $actual){if(-not $set.Remove($name)){throw 'Physical name differs'}}
   if($set.Count -ne 0){throw 'Missing physical member'}
  }
  $held.Check()
 }
 Assert-Tree
 [Console]::Out.WriteLine((@{type='ready';backendNativeIdentity=$backendId;files=$files;folders=$folders;bytes=$total.ToString()}|ConvertTo-Json -Compress))
 while($null -ne ($line=[Console]::In.ReadLine())){
  if($line.Length -gt 1024){throw 'Control bound'}
  $command=$line|ConvertFrom-Json
  if($command.id -notmatch '^[a-f0-9-]{36}$'){throw 'Control identity'}
  if($command.action -ceq 'close'){[Console]::Out.WriteLine((@{type='closed';id=$command.id}|ConvertTo-Json -Compress));break}
  if($command.action -cne 'check'){throw 'Control action'}
  Assert-Tree
  [Console]::Out.WriteLine((@{type='checked';id=$command.id}|ConvertTo-Json -Compress))
 }
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
finally{$held.Dispose();$deadline.Dispose()}
