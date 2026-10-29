param(
    [ValidateSet('Pilot', 'Full')]
    [string]$Phase = 'Pilot',
    [string]$RpcConfig = 'config/rpcs.poc.yaml',
    [ValidateSet('pilot', 'train', 'validation', 'test', 'unseen-contract')]
    [string[]]$Stages = @(),
    [ValidateRange(0, 10)]
    [int]$MaxStageRetries = 2,
    [ValidateRange(0, 300)]
    [int]$RetryDelaySeconds = 30
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$selectedStages = if ($Stages.Count -gt 0) { $Stages } elseif ($Phase -eq 'Pilot') { @('pilot') } else {
    @('train', 'validation', 'test', 'unseen-contract')
}

Push-Location -LiteralPath $repositoryRoot
try {
    New-Item -ItemType Directory -Force -Path 'models/extraction-logs' | Out-Null
    $runStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    foreach ($stage in $selectedStages) {
        $configuration = "config/extraction.e3.$stage.yaml"
        $logPath = "models/extraction-logs/e3-$runStamp-$stage.log"
        Write-Host "Starting/resuming $stage. Log: $logPath"
        for ($attempt = 0; $attempt -le $MaxStageRetries; $attempt++) {
            # Windows PowerShell treats native stderr as ErrorRecords. Inspect the
            # exit code ourselves so stderr cannot bypass logging and recovery.
            $previousPreference = $ErrorActionPreference
            $previousNativePreference = $PSNativeCommandUseErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $PSNativeCommandUseErrorActionPreference = $false
                & npm.cmd --prefix extractor run extract -- --config $configuration --rpcs $RpcConfig 2>&1 |
                    ForEach-Object { $_.ToString() } | Tee-Object -FilePath $logPath -Append
                $extractionExitCode = $LASTEXITCODE
            }
            finally {
                $ErrorActionPreference = $previousPreference
                $PSNativeCommandUseErrorActionPreference = $previousNativePreference
            }
            if ($extractionExitCode -eq 0) { break }
            if ($extractionExitCode -ne 2 -or $attempt -eq $MaxStageRetries) {
                throw "Extraction stopped at $stage (exit $extractionExitCode). Log: $logPath. Rerun to resume committed batches."
            }
            $message = "RPC recovery: resuming $stage from its checkpoint in $RetryDelaySeconds seconds (restart $($attempt + 1)/$MaxStageRetries)."
            $message | Tee-Object -FilePath $logPath -Append
            Start-Sleep -Seconds $RetryDelaySeconds
        }
        $output = if ($stage -eq 'pilot') {
            'data/extractions/e3-v1-pilot'
        } else { "data/extractions/e3-v1/$stage" }
        $manifest = Get-Content -LiteralPath "$output/manifest.json" -Raw | ConvertFrom-Json
        if ($manifest.complete -ne $true) {
            throw "Incomplete manifest for $stage; later stages will not run."
        }
        Write-Host "Completed $stage`: $($manifest.rowCount) rows."
    }
}
finally {
    Pop-Location
}
