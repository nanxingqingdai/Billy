$scriptPath = "C:\Users\rongh\Desktop\BillyCode\deploy\sync-data.ps1"
$action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
$task = Register-ScheduledTask -TaskName "BillyCode_SyncData" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force
Write-Host "任务已注册: $($task.TaskName) — 状态: $($task.State)"
