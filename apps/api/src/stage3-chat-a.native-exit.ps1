param([Parameter(Mandatory=$true)][string]$RootPath,[Parameter(Mandatory=$true)][string]$IdentityPath)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($RootPath)
$identityFile=[IO.Path]::GetFullPath($IdentityPath)
if([IO.Path]::GetDirectoryName($identityFile) -ne $root -or [IO.Path]::GetFileName($root) -notmatch '^owned-process-[a-f0-9-]{36}$' -or [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($root)) -notmatch '^stage3_[a-f0-9]{32}$'){throw 'Own fixture process root required'}
foreach($p in @($root,$identityFile)){if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse refused'}}
$expected=Get-Content -LiteralPath $identityFile -Raw | ConvertFrom-Json
if($expected.schema -ne 'saturn.test-native-exit.identity.v1' -or $expected.identity.pid -le 0){throw 'Exact native identity required'}
$target=[Diagnostics.Process]::GetProcessById([int]$expected.identity.pid)
$heldHandle=$target.Handle
$observed=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$expected.identity.pid)
if($null -eq $observed){throw 'Target absent before native wait'}
$actual=[ordered]@{pid=[int]$observed.ProcessId;parentPid=[int]$observed.ParentProcessId;exe=$observed.ExecutablePath;argv=$observed.CommandLine;created=$observed.CreationDate.ToUniversalTime().ToString('o')}
foreach($key in @('pid','parentPid','exe','argv','created')){if([string]$actual[$key] -cne [string]$expected.identity.$key){throw ('Native tuple differs: '+$key)}}
$nativeTicks=$target.StartTime.ToUniversalTime().Ticks
$expectedTicks=([datetime]::Parse([string]$expected.identity.created)).ToUniversalTime().Ticks
if(($nativeTicks-($nativeTicks%10)) -ne ($expectedTicks-($expectedTicks%10))){throw 'Held native process creation differs'}
function WriteNew([string]$Name,[object]$Value){
 $targetPath=Join-Path $root $Name
 $temporary=$targetPath+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 $bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 10 -Compress)+[Environment]::NewLine)
 $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 [IO.File]::Move($temporary,$targetPath)
}

WriteNew 'native-wait-ready.json' ([ordered]@{identity=$actual;heldNativeHandle=($heldHandle -ne [IntPtr]::Zero);heldNativeStartUtc=$target.StartTime.ToUniversalTime().ToString('o');readyAt=(Get-Date).ToUniversalTime().ToString('o');watcherPid=$PID})
$target.WaitForExit()
if($null -eq $target.ExitCode){throw 'Native exit code unavailable'}
$nativeExit=[int]$target.ExitCode
# Persist native numeric fact before any optional post-exit metadata.
WriteNew 'native-exit.json' ([ordered]@{pid=[int]$expected.identity.pid;nativeExitCode=$nativeExit;finishedAt=(Get-Date).ToUniversalTime().ToString('o');watcherPid=$PID;waitForExitReturned=$true})
$target.Dispose()
